# Writer backup on the lab workstation (task "\Writer\Writer Backup", every 6 hours).
#
# 1. pg_dump of the database (projects, files, history, comments: everything but templates) to
#    D:\writer-backups, kept 14 days; C:\writer\backups while D: is unplugged. Each dump is
#    checked with pg_restore --list.
# 2. A copy to the Beijing server (~/writer-backups, checked by SHA-256). writer-monitor.py
#    there keeps the last two days and one a day for 14 days.
# 3. Once a week, a restore drill: the newest dump is restored into a scratch database and
#    counted, then dropped.
# 4. A status file for the monitor on the Beijing server (~/writer-monitor/lab-status.json):
#    what worked, what did not, free disk space. The monitor alerts on Feishu when it is
#    missing for 7 hours or reports a problem.
#
# Restore: stop Writer Server, pg_restore -h 127.0.0.1 -U writer -d writer --clean <file>.
$ErrorActionPreference = "Continue"
$env:PGPASSFILE = "C:\writer\config\pgpass.conf"
$pg = "C:\writer\pgsql\bin"
$sshArgs = @("-F", "C:\Users\yuanbai\.ssh\config", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20")
$remote = "beijing"
$log = "C:\writer\logs\backup.log"
$drillMark = "C:\writer\logs\restore-drill.json"
function Log($text) { "[$(Get-Date -Format s)] $text" | Out-File -Append -Encoding utf8 $log }
$problems = New-Object System.Collections.Generic.List[string]
function Problem($text) { $problems.Add($text); Log "PROBLEM $text" }
function Counts($database, $user) {
  # One line, "users|projects|files|schema".
  $query = "SELECT (SELECT count(*) FROM users)||'|'||(SELECT count(*) FROM projects)||'|'||(SELECT count(*) FROM files)||'|'||(SELECT max(version) FROM schema_migrations)"
  (& "$pg\psql.exe" -h 127.0.0.1 -U $user -d $database -At -c $query 2>$null | Select-Object -First 1)
}

$dir = "D:\writer-backups"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir -ErrorAction SilentlyContinue | Out-Null }
if (-not (Test-Path $dir)) { $dir = "C:\writer\backups"; New-Item -ItemType Directory -Force $dir | Out-Null; Problem "D: 盘没有接上，备份暂存在 C:\writer\backups" }
$name = "writer-$(Get-Date -Format yyyyMMdd-HHmm).dump"
$file = Join-Path $dir $name
& "$pg\pg_dump.exe" -h 127.0.0.1 -U writer -d writer -Fc -f $file
$dumped = ($LASTEXITCODE -eq 0) -and (Test-Path $file)
Log "backup $file exit $LASTEXITCODE"
if (-not $dumped) { Problem "数据库备份（pg_dump）失败，见 C:\writer\logs\backup.log" }
else {
  & "$pg\pg_restore.exe" --list $file > $null 2>&1
  if ($LASTEXITCODE -ne 0) { $dumped = $false; Problem "备份文件 $name 无法读取（pg_restore --list 失败）" }
}
Get-ChildItem $dir -Filter "writer-*.dump" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force

# Templates members publish live on E: (the template library); mirror it beside the dumps,
# without the downloaded author kits, which template-build.ts fetches again.
if (Test-Path E:\writer-data\templates) {
  robocopy E:\writer-data\templates "$dir\templates" /MIR /XD .cache *.partial *.old *.deleted-* /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  Log "templates mirrored to $dir\templates (robocopy $LASTEXITCODE)"
  if ($LASTEXITCODE -ge 8) { Problem "模板库镜像到 $dir\templates 失败（robocopy $LASTEXITCODE）" }
}

# Off-site copy.
$offsite = $false
if ($dumped) {
  & C:\Windows\System32\OpenSSH\scp.exe @sshArgs -q $file "${remote}:writer-backups/$name"
  if ($LASTEXITCODE -eq 0) {
    $local = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    # -n: with an inherited stdin that never closes, Windows' ssh would wait for it forever.
    $copied = (& C:\Windows\System32\OpenSSH\ssh.exe @sshArgs -n $remote "sha256sum writer-backups/$name" 2>$null) -split ' ' | Select-Object -First 1
    $offsite = $copied -eq $local
  }
  Log "offsite copy to $remote $(if ($offsite) { 'ok' } else { 'FAILED' })"
  if (-not $offsite) { Problem "备份没能复制到北京服务器" }
}

# Weekly restore drill into a scratch database, as the postgres superuser.
$drill = $null
if (Test-Path $drillMark) { $drill = Get-Content $drillMark -Raw | ConvertFrom-Json }
$due = (-not $drill) -or ([DateTimeOffset]::Now.ToUnixTimeSeconds() - $drill.time -gt 7 * 86400)
if ($dumped -and $due) {
  $env:PGPASSWORD = (Get-Content C:\writer\config\secrets.json -Raw | ConvertFrom-Json).postgres
  $scratch = "writer_restore_check"
  & "$pg\dropdb.exe" -h 127.0.0.1 -U postgres --if-exists $scratch 2>$null
  & "$pg\createdb.exe" -h 127.0.0.1 -U postgres $scratch
  & "$pg\pg_restore.exe" -h 127.0.0.1 -U postgres -d $scratch --no-owner --no-privileges $file 2>$null
  $restoreExit = $LASTEXITCODE
  $restored = Counts $scratch "postgres"
  & "$pg\dropdb.exe" -h 127.0.0.1 -U postgres --if-exists $scratch 2>$null
  Remove-Item Env:\PGPASSWORD
  $live = Counts "writer" "writer"
  # Counts are logged beside the live ones (which may have moved on since the dump); the drill
  # passes when the restore succeeds, has accounts and projects, and is at the live schema.
  $r = "$restored" -split '\|'; $l = "$live" -split '\|'
  $ok = ($restoreExit -eq 0) -and ($r.Count -eq 4) -and ([int]$r[0] -gt 0) -and ([int]$r[1] -gt 0) -and ($r[3] -eq $l[3])
  $drill = [ordered]@{ time = [DateTimeOffset]::Now.ToUnixTimeSeconds(); ok = $ok; file = $name; restored = "$restored"; live = "$live" }
  $drill | ConvertTo-Json -Compress | Out-File -Encoding utf8 $drillMark
  Log "restore drill $(if ($ok) { 'ok' } else { 'FAILED' }): restored $restored, live $live (pg_restore exit $restoreExit)"
}
if ($drill -and -not $drill.ok) { Problem "恢复演练失败（$($drill.file)：恢复出 $($drill.restored)，现有 $($drill.live)），见 backup.log" }

# Status for the monitor.
$disks = [ordered]@{}
foreach ($d in Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -in "C", "D", "E" -and $_.Used -ne $null }) {
  $disks[$d.Name] = [math]::Round($d.Free / 1GB, 1)
}
$status = [ordered]@{
  time = [DateTimeOffset]::Now.ToUnixTimeSeconds()
  file = $name
  bytes = $(if ($dumped) { (Get-Item $file).Length } else { 0 })
  offsite = $offsite
  drill = $drill
  disks = $disks
  problems = @($problems)
}
$statusFile = "C:\writer\logs\lab-status.json"
# ConvertTo-Json in PowerShell 5.1 writes a BOM with -Encoding utf8; the monitor reads plain UTF-8.
[IO.File]::WriteAllText($statusFile, ($status | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
& C:\Windows\System32\OpenSSH\scp.exe @sshArgs -q $statusFile "${remote}:writer-monitor/lab-status.json"
if ($LASTEXITCODE -ne 0) { Log "status not sent to $remote (scp $LASTEXITCODE)" }
