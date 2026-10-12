# One public address of Writer: a reverse SSH tunnel from this computer's port 80 to 127.0.0.1:18090
# on a relay (nginx in Beijing, Caddy in Los Angeles forward to it). Started hidden, once per relay,
# by C:\writer\run-writer.ps1 (the Writer Server task); lives in C:\writer\network.
#
# When the connection drops, ssh notices within a minute (ServerAlive*) and this loop connects
# again. A connection that dies silently (the lab's network changes, a NAT forgets it) is not
# noticed by the relay, whose sshd keeps holding the port: every new tunnel is then refused
# ("remote port forwarding failed") and the address stays dead. So after a tunnel that failed at
# once, the relay is asked to end whatever holds the port; this tunnel being down, it is stale.
param(
  [Parameter(Mandatory=$true)][ValidateSet('beijing','la')][string]$Endpoint,
  # Another port only to try this script beside the running tunnel.
  [int]$RemotePort = 18090
)
$ErrorActionPreference = 'Stop'
$root = 'C:\writer\network'
$name = if ($RemotePort -eq 18090) { $Endpoint } else { "$Endpoint-$RemotePort" }
$log = "C:\writer\logs\tunnel-$name.log"
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
# A file lock works across both interactive and boot-time task sessions.
try {
  $lock = [IO.File]::Open("$root\$name.lock", 'OpenOrCreate', 'ReadWrite', 'None')
} catch [IO.IOException] { exit 0 }
function Say([string]$text) {
  "[$(Get-Date -Format s)] $text" | Out-File -LiteralPath $log -Append -Encoding utf8
}
try {
  $common = @('-F', 'C:\Users\yuanbai\.ssh\config',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes', '-o', 'ForwardAgent=no', '-o', 'LogLevel=ERROR')
  $tunnelArgs = $common + @('-N', '-T', '-o', 'ExitOnForwardFailure=yes',
    '-E', $log, '-R', "127.0.0.1:${RemotePort}:127.0.0.1:80", $Endpoint)
  # Ends the sshd session holding the relay's port. ssh.exe runs apart, its input and output in
  # files: captured by Windows PowerShell 5 (`& ssh.exe ... 2>&1`) it does not return.
  $freeScript = "$root\$name.free.sh"
  [IO.File]::WriteAllText($freeScript, ("for p in `$(sudo -n ss -ltnp 'sport = :$RemotePort' | " +
    "grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do sudo -n kill `"`$p`" && " +
    "echo `"ended stale sshd `$p holding port $RemotePort`"; done`n"))
  function Free-RelayPort {
    $out = "$root\$name.free.out"
    $p = Start-Process -FilePath $ssh -ArgumentList ($common + @($Endpoint, 'bash', '-s')) -NoNewWindow `
      -RedirectStandardInput $freeScript -RedirectStandardOutput $out -RedirectStandardError "$out.err" -PassThru
    if (-not $p.WaitForExit(30000)) { $p.Kill(); Say "relay cleanup timed out" }
    foreach ($line in (Get-Content -LiteralPath $out, "$out.err" -ErrorAction SilentlyContinue)) {
      if ($line) { Say "relay: $line" }
    }
  }
  while ($true) {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) {
      Move-Item -LiteralPath $log -Destination "$log.old" -Force
    }
    Say "connecting $Endpoint"
    $started = Get-Date
    # A dedicated error log keeps OpenSSH diagnostics out of the Writer process log.
    & $ssh @tunnelArgs
    $code = $LASTEXITCODE
    $quick = ((Get-Date) - $started).TotalSeconds -lt 10
    Say "disconnected ($code); retrying"
    if ($quick) {
      try { Free-RelayPort } catch { Say "relay cleanup failed: $_" }
    }
    Start-Sleep -Seconds $(if ($quick) { 15 } else { 5 })
  }
} finally { $lock.Dispose() }
