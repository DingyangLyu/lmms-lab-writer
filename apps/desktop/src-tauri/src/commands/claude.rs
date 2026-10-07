//! Native Claude Code stream-json bridge. Claude owns login and resumable context.
use super::util::command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::{broadcast, Mutex, Notify},
    time::{timeout, Duration},
};

pub struct ClaudeState {
    runs: StdMutex<HashMap<String, Arc<Run>>>,
    /// One writer per transcript; different sessions never wait on each other.
    storage: StdMutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Model catalogs per project, so each restored tab does not spawn its own CLI probe.
    catalogs: Mutex<HashMap<PathBuf, (std::time::Instant, Value)>>,
    events: broadcast::Sender<(String, Value)>,
}
impl Default for ClaudeState {
    fn default() -> Self {
        Self {
            runs: StdMutex::new(HashMap::new()),
            storage: StdMutex::new(HashMap::new()),
            catalogs: Mutex::new(HashMap::new()),
            events: broadcast::channel(2048).0,
        }
    }
}
struct Run {
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, Value>>,
    cancel: Notify,
    busy: AtomicBool,
    pid: u32,
    delivery: Mutex<DeliveryState>,
}
struct DeliveryState {
    accepting: bool,
    initialized: bool,
    outstanding: usize,
}
impl DeliveryState {
    fn finish_result(&mut self) -> bool {
        if self.accepting && self.outstanding > 1 {
            self.outstanding -= 1;
            return false;
        }
        self.accepting = false;
        true
    }
}
impl ClaudeState {
    fn session_lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.storage
            .lock()
            .map(|mut locks| locks.entry(id.to_string()).or_default().clone())
            .unwrap_or_default()
    }
    pub fn shutdown_now(&self) {
        if let Ok(runs) = self.runs.lock() {
            for run in runs.values() {
                #[cfg(unix)]
                unsafe {
                    if run.pid > 0 {
                        libc::kill(-(run.pid as i32), libc::SIGTERM);
                    }
                }
                run.cancel.notify_one();
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    id: String,
    name: String,
    directory: String,
    updated_at: u64,
    #[serde(default)]
    native: bool,
}
#[derive(Serialize, Deserialize)]
struct Transcript {
    session: Session,
    events: Vec<Value>,
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
async fn directory(path: &str) -> Result<PathBuf, String> {
    let p = tokio::fs::canonicalize(path)
        .await
        .map_err(|e| e.to_string())?;
    if !p.is_dir() {
        return Err("请先打开项目文件夹。".into());
    }
    Ok(p)
}
fn session_path(app: &AppHandle, dir: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效 Claude 会话 ID")?;
    let hash = dir
        .to_string_lossy()
        .bytes()
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ b as u64).wrapping_mul(0x100000001b3)
        });
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("claude-sessions")
        .join(format!("{hash:016x}"))
        .join(format!("{id}.json")))
}
/// `<id>.json` holds session metadata; events are appended to `<id>.jsonl` in O(1).
fn log_path(path: &Path) -> PathBuf {
    path.with_extension("jsonl")
}
async fn load_meta(path: &Path) -> Result<Transcript, String> {
    serde_json::from_slice(&tokio::fs::read(path).await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
async fn has_events(path: &Path, meta: &Transcript) -> bool {
    !meta.events.is_empty()
        || tokio::fs::metadata(log_path(path))
            .await
            .is_ok_and(|m| m.len() > 0)
}
async fn load(path: &Path) -> Result<Transcript, String> {
    let mut t = load_meta(path).await?;
    match tokio::fs::read(log_path(path)).await {
        // A line cut short by a crash is skipped rather than failing the whole history.
        Ok(bytes) => t.events.extend(
            bytes
                .split(|b| *b == b'\n')
                .filter(|line| !line.is_empty())
                .filter_map(|line| serde_json::from_slice::<Value>(line).ok()),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(t)
}
fn lines(events: &[Value]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for event in events {
        bytes.extend(serde_json::to_vec(event).map_err(|e| e.to_string())?);
        bytes.push(b'\n');
    }
    Ok(bytes)
}
/// Older transcripts kept every event inside the metadata file; move them to the log once.
async fn migrate(path: &Path, meta: &mut Transcript) -> Result<(), String> {
    if meta.events.is_empty() {
        return Ok(());
    }
    let log = log_path(path);
    let legacy = lines(&meta.events)?;
    let existing = match tokio::fs::read(&log).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.to_string()),
    };
    // An interrupted earlier migration already wrote the legacy events first.
    if !existing.starts_with(&legacy) {
        let temp = log.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&temp, [legacy, existing].concat())
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&temp, &log)
            .await
            .map_err(|e| e.to_string())?;
    }
    meta.events.clear();
    store(path, meta).await
}
async fn append_event(path: &Path, event: &Value, native: bool) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut meta = load_meta(path).await?;
    migrate(path, &mut meta).await?;
    let log = log_path(path);
    let mut line = serde_json::to_vec(event).map_err(|e| e.to_string())?;
    line.push(b'\n');
    if let Ok(mut file) = tokio::fs::File::open(&log).await {
        let len = file.metadata().await.map_err(|e| e.to_string())?.len();
        let mut last = [0u8];
        if len > 0
            && file.seek(std::io::SeekFrom::End(-1)).await.is_ok()
            && file.read_exact(&mut last).await.is_ok()
            && last[0] != b'\n'
        {
            line.insert(0, b'\n');
        }
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .await
        .map_err(|e| e.to_string())?;
    file.write_all(&line).await.map_err(|e| e.to_string())?;
    file.flush().await.map_err(|e| e.to_string())?;
    if native && !meta.session.native {
        meta.session.native = true;
        meta.session.updated_at = now();
        store(path, &meta).await?;
    }
    Ok(())
}
async fn store(path: &Path, transcript: &Transcript) -> Result<(), String> {
    tokio::fs::create_dir_all(path.parent().ok_or("无效存储目录")?)
        .await
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(
        &temp,
        serde_json::to_vec(transcript).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, path)
        .await
        .map_err(|e| e.to_string())
}
async fn append(
    app: &AppHandle,
    id: &str,
    path: &Path,
    event: Value,
    native: bool,
) -> Result<(), String> {
    let lock = app.state::<ClaudeState>().session_lock(id);
    let _lock = lock.lock().await;
    append_event(path, &event, native).await
}
async fn binary() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|p| {
                    p.join(if cfg!(windows) {
                        "claude.exe"
                    } else {
                        "claude"
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    {
        candidates.extend([
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
        ]);
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]);
    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("未找到 Claude Code。请先在终端安装 Claude Code，并完成 claude auth login。".into())
}
fn emit(app: &AppHandle, session: &Session, event: &Value) {
    let _ = app
        .state::<ClaudeState>()
        .events
        .send((session.id.clone(), event.clone()));
    let _ = app.emit(
        "claude://event",
        json!({"sessionId":session.id,"directory":session.directory,"event":event}),
    );
}
async fn send(input: &Mutex<ChildStdin>, message: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut input = input.lock().await;
    input.write_all(&bytes).await.map_err(|e| e.to_string())?;
    input.flush().await.map_err(|e| e.to_string())
}
fn protocol_command(bin: &Path, dir: &Path) -> tokio::process::Command {
    let mut cmd = command(&bin.to_string_lossy());
    cmd.current_dir(dir)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}
#[tauri::command]
pub async fn claude_initialize(
    state: tauri::State<'_, ClaudeState>,
    cwd: String,
) -> Result<Value, String> {
    let dir = directory(&cwd).await?;
    // Held across the probe: tabs restored together share one CLI process and its result.
    let mut catalogs = state.catalogs.lock().await;
    if let Some((at, value)) = catalogs.get(&dir) {
        if at.elapsed() < Duration::from_secs(600) {
            return Ok(value.clone());
        }
    }
    let result = probe_models(&dir).await;
    if let Ok(value) = &result {
        catalogs.insert(dir, (std::time::Instant::now(), value.clone()));
    }
    result
}
async fn probe_models(dir: &Path) -> Result<Value, String> {
    let bin = binary().await?;
    let mut child = protocol_command(&bin, dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    let input = Mutex::new(child.stdin.take().ok_or("Claude stdin 不可用")?);
    let mut lines = BufReader::new(child.stdout.take().ok_or("Claude stdout 不可用")?).lines();
    send(&input, json!({"type":"control_request","request_id":"writer-init","request":{"subtype":"initialize"}})).await?;
    let result = timeout(Duration::from_secs(40), async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if event["type"] == "control_response"
                    && event["response"]["request_id"] == "writer-init"
                {
                    if event["response"]["subtype"] == "error" {
                        return Err(event["response"]["error"].to_string());
                    }
                    return Ok(
                        json!({"models":event["response"]["response"]["models"],"available":true}),
                    );
                }
            }
        }
        Err("Claude Code 初始化退出，请检查本机 CLI 配置。".into())
    })
    .await
    .map_err(|_| "Claude Code 初始化超时".to_string())
    .and_then(|v| v);
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    let _ = child.kill().await;
    result
}
#[tauri::command]
pub async fn claude_list_sessions(app: AppHandle, cwd: String) -> Result<Value, String> {
    let dir = directory(&cwd).await?;
    let path = session_path(&app, &dir, &uuid::Uuid::nil().to_string())?;
    let mut sessions = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(path.parent().ok_or("存储目录不可用")?).await
    {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Ok(mut t) = load_meta(&path).await {
                    if has_events(&path, &t).await {
                        // Appends only touch the log; its mtime is the latest activity.
                        if let Some(modified) = tokio::fs::metadata(log_path(&path))
                            .await
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                        {
                            t.session.updated_at =
                                t.session.updated_at.max(modified.as_millis() as u64);
                        }
                        sessions.push(t.session);
                    }
                }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(json!(sessions))
}
#[tauri::command]
pub async fn claude_create_session(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
    cwd: String,
) -> Result<Session, String> {
    let dir = directory(&cwd).await?;
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        name: "新对话".into(),
        directory: dir.to_string_lossy().into_owned(),
        updated_at: now(),
        native: false,
    };
    let path = session_path(&app, &dir, &session.id)?;
    let lock = state.session_lock(&session.id);
    let _lock = lock.lock().await;
    store(
        &path,
        &Transcript {
            session: session.clone(),
            events: vec![],
        },
    )
    .await?;
    Ok(session)
}
#[tauri::command]
pub async fn claude_read_session(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
    cwd: String,
    session_id: String,
) -> Result<Value, String> {
    let dir = directory(&cwd).await?;
    let lock = state.session_lock(&session_id);
    let _lock = lock.lock().await;
    let t = load(&session_path(&app, &dir, &session_id)?).await?;
    let run = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned();
    let busy = run.as_ref().is_some_and(|r| r.busy.load(Ordering::Acquire));
    let pending: Vec<Value> = if let Some(r) = run {
        r.pending.lock().await.values().cloned().collect()
    } else {
        vec![]
    };
    Ok(json!({"session":t.session,"events":t.events,"busy":busy,"pending":pending}))
}
#[tauri::command]
pub async fn claude_rename_session(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
    cwd: String,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("对话名称需为 1–120 个字符。".into());
    }
    let dir = directory(&cwd).await?;
    let path = session_path(&app, &dir, &session_id)?;
    let lock = state.session_lock(&session_id);
    let _lock = lock.lock().await;
    let mut t = load_meta(&path).await?;
    t.session.name = name.into();
    store(&path, &t).await
}
fn claude_input(text: &str, images: Vec<String>) -> Result<Value, String> {
    let validated = super::chat_images::codex_input(text, images)?;
    let mut content = Vec::new();
    for part in validated {
        if let Some(url) = part["url"].as_str() {
            let (header, data) = url.split_once(',').ok_or("无效图片")?;
            content.push(json!({"type":"image","source":{"type":"base64","media_type":header.trim_start_matches("data:").trim_end_matches(";base64"),"data":data}}));
        } else {
            content.push(part);
        }
    }
    Ok(
        json!({"type":"user","session_id":"","message":{"role":"user","content":content},"parent_tool_use_id":null,"uuid":uuid::Uuid::new_v4().to_string()}),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOptions {
    model: Option<String>,
    effort: Option<String>,
    permission_mode: String,
}
fn permission_args(mode: &str) -> Result<Vec<&str>, String> {
    match mode {
        "default" | "acceptEdits" | "plan" => Ok(vec!["--permission-mode", mode]),
        "bypassPermissions" => Ok(vec![
            "--permission-mode",
            mode,
            "--dangerously-skip-permissions",
        ]),
        _ => Err("不支持的 Claude 权限模式".into()),
    }
}
#[tauri::command]
pub async fn claude_start_turn(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
    cwd: String,
    session_id: String,
    text: String,
    images: Vec<String>,
    options: TurnOptions,
) -> Result<(), String> {
    let permission_args = permission_args(&options.permission_mode)?;
    if options
        .effort
        .as_ref()
        .is_some_and(|e| !["low", "medium", "high", "xhigh", "max"].contains(&e.as_str()))
    {
        return Err("无效推理强度".into());
    }
    let input_message = claude_input(&text, images)?;
    let dir = directory(&cwd).await?;
    let path = session_path(&app, &dir, &session_id)?;
    let bin = binary().await?;
    let lock = state.session_lock(&session_id);
    let _lock = lock.lock().await;
    if state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .is_some_and(|r| r.busy.load(Ordering::Acquire))
    {
        return Err("该对话仍在执行。".into());
    }
    let mut t = load_meta(&path).await?;
    migrate(&path, &mut t).await?;
    let started = has_events(&path, &t).await;
    let endpoint = super::writer_bridge::ensure(&app).await?;
    let config = json!({"mcpServers":{"writer_bridge":{"type":"http","url":format!("{}/mcp/claude", endpoint.url),"headers":{"Authorization":"Bearer ${WRITER_CLAUDE_MCP_TOKEN}"}}}});
    let mut cmd = protocol_command(&bin, &dir);
    // Keep the ephemeral bearer token out of argv and the project directory.
    cmd.arg("--mcp-config")
        .arg(config.to_string())
        .env("WRITER_CLAUDE_MCP_TOKEN", endpoint.claude_token);
    cmd.arg(if t.session.native {
        format!("--resume={session_id}")
    } else {
        format!("--session-id={session_id}")
    });
    cmd.args(permission_args);
    cmd.arg("--append-system-prompt").arg(format!("You are working in LMMs-Lab Writer, a local LaTeX writing app. Follow the user's requested scope. Preserve unrelated changes. Verify citations against primary sources and never invent bibliographic details. Use the project's configured LaTeX entry points. Link project files with relative Markdown links and line numbers when useful.\n{}", super::writer_bridge::context("claude", &session_id)));
    if let Some(model) = options.model.filter(|v| !v.is_empty() && v != "default") {
        cmd.arg(format!("--model={model}"));
    }
    if let Some(effort) = options.effort {
        cmd.arg("--effort").arg(effort);
    }
    // Capture the baseline before the process exists, so no edit can precede it.
    let actor = format!("claude:{session_id}");
    super::reviews::begin_or_report(&app, &cwd, &actor).await;
    let review = super::reviews::TurnGuard::new(&app, &actor);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Claude Code 启动失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("Claude stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Claude stderr 不可用")?;
    let run = Arc::new(Run {
        input: Mutex::new(child.stdin.take().ok_or("Claude stdin 不可用")?),
        pending: Mutex::new(HashMap::new()),
        cancel: Notify::new(),
        busy: AtomicBool::new(true),
        pid: child.id().unwrap_or(0),
        delivery: Mutex::new(DeliveryState {
            accepting: true,
            initialized: false,
            outstanding: 1,
        }),
    });
    if !started {
        t.session.name = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("图片任务")
            .chars()
            .take(40)
            .collect();
    }
    append_event(&path, &input_message, false).await?;
    t.session.updated_at = now();
    store(&path, &t).await?;
    state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), run.clone());
    let session = t.session;
    emit(&app, &session, &input_message);
    let init = json!({"type":"control_request","request_id":"writer-init","request":{"subtype":"initialize"}});
    if let Err(error) = send(&run.input, init).await {
        run.busy.store(false, Ordering::Release);
        // Do not keep a dead process ID in the exit-cleanup registry.
        state
            .runs
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&session_id);
        #[cfg(unix)]
        if run.pid > 0 {
            unsafe {
                libc::kill(-(run.pid as i32), libc::SIGTERM);
            }
        }
        let _ = child.kill().await;
        return Err(error);
    }
    review.disarm();
    super::writer_bridge::set_busy(&app, "claude", &session_id, true).await;
    tokio::spawn(async move {
        emit(&app, &session, &json!({"type":"writer_started"}));
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut tail = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > 8000 {
                    tail = tail
                        .chars()
                        .rev()
                        .take(4000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                }
            }
            tail
        });
        let mut lines = BufReader::new(stdout).lines();
        let mut initialized = false;
        let mut result_seen = false;
        let mut failure = None;
        let deadline = tokio::time::sleep(Duration::from_secs(60));
        tokio::pin!(deadline);
        loop {
            let line = tokio::select! {
                _=run.cancel.notified()=>{ failure=Some("已停止 Claude Code。".to_string()); break; },
                _=&mut deadline, if !initialized=>{ failure=Some("Claude Code 初始化超时。".to_string()); break; },
                line=lines.next_line()=>match line {Ok(Some(line))=>line,Ok(None)=>break,Err(e)=>{failure=Some(e.to_string());break;}}
            };
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if event["type"] == "control_response"
                && event["response"]["request_id"] == "writer-init"
            {
                if event["response"]["subtype"] == "error" {
                    failure = Some(event["response"]["error"].to_string());
                    break;
                }
                initialized = true;
                let mut delivery = run.delivery.lock().await;
                if let Err(e) = send(&run.input, input_message.clone()).await {
                    failure = Some(e);
                    break;
                }
                delivery.initialized = true;
                continue;
            }
            if event["type"] == "control_request" {
                if let Some(id) = event["request_id"].as_str() {
                    if event["request"]["subtype"] == "can_use_tool" {
                        run.pending.lock().await.insert(id.into(), event.clone());
                    } else {
                        let _=send(&run.input,json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Unsupported control request"}})).await;
                        continue;
                    }
                }
            }
            if event["type"] == "control_cancel_request" {
                if let Some(id) = event["request_id"].as_str() {
                    run.pending.lock().await.remove(id);
                }
            }
            if event["type"] == "result" {
                let mut delivery = run.delivery.lock().await;
                if !delivery.finish_result() {
                    run.pending.lock().await.clear();
                    emit(&app, &session, &json!({"type":"writer_steering"}));
                    continue;
                }
            }
            if ["assistant", "user", "result"].contains(&event["type"].as_str().unwrap_or(""))
                || event["type"] == "system" && event["subtype"] == "init"
            {
                if let Err(e) = append(
                    &app,
                    &session_id,
                    &path,
                    event.clone(),
                    event["type"] == "assistant" || event["type"] == "system",
                )
                .await
                {
                    failure = Some(format!("历史保存失败：{e}"));
                }
            }
            emit(&app, &session, &event);
            if event["type"] == "result" {
                result_seen = true;
                break;
            }
        }
        run.pending.lock().await.clear();
        let _ = run.input.lock().await.shutdown().await;
        if !result_seen {
            #[cfg(unix)]
            if run.pid > 0 {
                unsafe {
                    libc::kill(-(run.pid as i32), libc::SIGTERM);
                }
            }
            let _ = child.start_kill();
        }
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        let stderr = timeout(Duration::from_secs(1), stderr_task)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        if !result_seen && failure.is_none() {
            failure = Some(if stderr.trim().is_empty() {
                "Claude Code 提前退出，请检查本机登录和模型配置。".into()
            } else {
                stderr
            });
        }
        run.busy.store(false, Ordering::Release);
        if let Some(error) = failure {
            let event = json!({"type":"writer_error","error":error});
            let _ = append(&app, &session_id, &path, event.clone(), false).await;
            emit(&app, &session, &event);
        }
        super::writer_bridge::set_busy(&app, "claude", &session_id, false).await;
        emit(&app, &session, &json!({"type":"writer_done"}));
        if let Ok(mut runs) = app.state::<ClaudeState>().runs.lock() {
            if runs
                .get(&session_id)
                .is_some_and(|active| Arc::ptr_eq(active, &run))
            {
                runs.remove(&session_id);
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn claude_steer_turn(
    app: AppHandle,
    state: tauri::State<'_, ClaudeState>,
    cwd: String,
    session_id: String,
    text: String,
    images: Vec<String>,
) -> Result<(), String> {
    let dir = directory(&cwd).await?;
    let path = session_path(&app, &dir, &session_id)?;
    let message = claude_input(&text, images)?;
    let run = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned()
        .ok_or("当前任务已结束，请正常发送。")?;
    let mut delivery = run.delivery.lock().await;
    if !run.busy.load(Ordering::Acquire) || !delivery.accepting || !delivery.initialized {
        return Err("当前任务已结束或尚未就绪，请稍后正常发送。".into());
    }
    if delivery.outstanding > 1 {
        return Err("上一条指导正在接入，请稍后发送或加入队列。".into());
    }
    let session = load_meta(&path).await?.session;
    // Interrupt and user input share ordered stdin. Keep reading through the interrupted
    // result so the replacement user message is handled by this same native session.
    delivery.outstanding += 1;
    let result = async {
        send(&run.input,json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":{"subtype":"interrupt"}})).await?;
        send(&run.input,message.clone()).await?;
        append(&app,&session_id,&path,message.clone(),false).await?;
        emit(&app,&session,&message);
        Ok::<(),String>(())
    }.await;
    if result.is_err() {
        run.cancel.notify_one();
    }
    result
}

#[tauri::command]
pub async fn claude_respond_permission(
    state: tauri::State<'_, ClaudeState>,
    session_id: String,
    request_id: String,
    allow: bool,
    answers: Option<Value>,
) -> Result<(), String> {
    let run = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned()
        .ok_or("Claude 对话已结束")?;
    let mut pending = run.pending.lock().await;
    let request = pending.get(&request_id).ok_or("该权限请求已结束")?;
    let mut input = request["request"]["input"].clone();
    if request["request"]["tool_name"] == "AskUserQuestion" && allow {
        input["answers"] = answers.unwrap_or(json!({}));
    }
    let decision = if allow {
        json!({"behavior":"allow","updatedInput":input})
    } else {
        json!({"behavior":"deny","message":"用户拒绝了本次操作。"})
    };
    send(&run.input,json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":decision}})).await?;
    pending.remove(&request_id);
    Ok(())
}
#[tauri::command]
pub async fn claude_stop(
    state: tauri::State<'_, ClaudeState>,
    session_id: String,
) -> Result<(), String> {
    let run = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .cloned()
        .ok_or("Claude 对话已结束")?;
    run.delivery.lock().await.accepting = false;
    let _=send(&run.input,json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":{"subtype":"interrupt"}})).await;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if run.busy.load(Ordering::Acquire) {
            run.cancel.notify_one();
        }
    });
    Ok(())
}
/// Subscribe before starting so even a fast response cannot be missed. No polling.
pub async fn bridge_turn(
    app: AppHandle,
    session: super::writer_bridge::Conversation,
    text: String,
) -> Result<String, String> {
    let id = session
        .id
        .strip_prefix("claude:")
        .ok_or("无效 Claude 会话 ID")?
        .to_string();
    let state = app.state::<ClaudeState>();
    let mut events = state.events.subscribe();
    let options = TurnOptions {
        model: session.options["model"].as_str().map(String::from),
        effort: session.options["effort"].as_str().map(String::from),
        permission_mode: session.options["permissionMode"]
            .as_str()
            .unwrap_or("default")
            .into(),
    };
    claude_start_turn(
        app.clone(),
        state,
        session.project,
        id.clone(),
        text,
        vec![],
        options,
    )
    .await?;
    let mut result = None;
    loop {
        let (event_id, event) = events
            .recv()
            .await
            .map_err(|e| format!("Claude 回信连接中断：{e}"))?;
        if event_id != id {
            continue;
        }
        match event["type"].as_str() {
            Some("result") => {
                result = Some(if event["is_error"].as_bool().unwrap_or(false) {
                    Err(event["errors"]
                        .as_array()
                        .map(|v| {
                            v.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_else(|| "Claude 执行失败".into()))
                } else {
                    Ok(event["result"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(40000)
                        .collect())
                });
            }
            Some("writer_error") => {
                result = Some(Err(event["error"]
                    .as_str()
                    .unwrap_or("Claude 执行失败")
                    .into()))
            }
            Some("writer_done") => {
                return result.unwrap_or_else(|| Err("Claude 未返回结果".into()))
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bypass_is_explicit_and_other_modes_do_not_gain_it() {
        assert_eq!(
            permission_args("bypassPermissions").unwrap(),
            [
                "--permission-mode",
                "bypassPermissions",
                "--dangerously-skip-permissions"
            ]
        );
        for mode in ["default", "acceptEdits", "plan"] {
            assert_eq!(permission_args(mode).unwrap(), ["--permission-mode", mode]);
        }
        // dontAsk denies unapproved operations; it is not full access.
        assert!(permission_args("dontAsk").is_err());
        assert!(permission_args("unknown").is_err());
    }
    #[test]
    fn steering_keeps_the_stream_open_until_the_replacement_result() {
        let mut delivery = DeliveryState {
            accepting: true,
            initialized: true,
            outstanding: 2,
        };
        assert!(!delivery.finish_result());
        assert!(delivery.accepting);
        assert_eq!(delivery.outstanding, 1);
        assert!(delivery.finish_result());
        assert!(!delivery.accepting);
    }
    #[test]
    fn explicit_stop_wins_over_a_pending_steer() {
        let mut delivery = DeliveryState {
            accepting: false,
            initialized: true,
            outstanding: 2,
        };
        assert!(delivery.finish_result());
    }
    #[tokio::test]
    async fn transcript_and_renamed_title_survive_reload() {
        let dir =
            std::env::temp_dir().join(format!("writer-claude-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("session.json");
        let mut transcript = Transcript {
            session: Session {
                id: uuid::Uuid::new_v4().to_string(),
                name: "文献核对".into(),
                directory: "/paper".into(),
                updated_at: now(),
                native: true,
            },
            events: vec![
                json!({"type":"user","message":{"content":"保留原始请求"}}),
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"核对完成"}]}}),
            ],
        };
        store(&path, &transcript).await.unwrap();
        transcript.session.name = "中文论文 · 方法".into();
        store(&path, &transcript).await.unwrap();
        let restored = load(&path).await.unwrap();
        assert_eq!(restored.session.name, "中文论文 · 方法");
        assert!(restored.session.native);
        assert_eq!(restored.events, transcript.events);
        // Appending moves legacy events to the log once and keeps their order.
        let next = json!({"type":"result","result":"完成"});
        append_event(&path, &next, false).await.unwrap();
        tokio::fs::write(log_path(&path), {
            let mut bytes = tokio::fs::read(log_path(&path)).await.unwrap();
            bytes.extend(b"{\"type\":\"assist");
            bytes
        })
        .await
        .unwrap();
        append_event(&path, &next, false).await.unwrap();
        assert!(load_meta(&path).await.unwrap().events.is_empty());
        let mut expected = transcript.events.clone();
        expected.extend([next.clone(), next]);
        assert_eq!(load(&path).await.unwrap().events, expected);
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn formats_images_as_claude_content_without_dropping_text() {
        use base64::Engine;
        let image = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture")
        );
        let input = claude_input("Describe", vec![image]).unwrap();
        assert_eq!(input["message"]["content"][0]["text"], "Describe");
        assert_eq!(
            input["message"]["content"][1]["source"]["media_type"],
            "image/png"
        );
        assert!(claude_input("", vec![]).is_err());
        assert!(claude_input("Read", vec!["file:///secret".into()]).is_err());
    }
}
