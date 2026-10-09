//! Persistent bridge to the locally installed Codex app-server.
//!
//! The bridge speaks newline-delimited JSON-RPC over stdio. Codex owns its
//! authentication and conversation history; Writer never reads auth.json.

use super::util::command;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

const EVENT_NAME: &str = "codex://event";

/// The permission choices shown in Writer's Codex composer. Keep the wire
/// values here so the frontend never has to construct app-server policies.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CodexPermissionMode {
    ReadOnly,
    #[default]
    AskForApproval,
    AutoReview,
    FullAccess,
}

impl CodexPermissionMode {
    fn approval_policy(self) -> &'static str {
        match self {
            Self::FullAccess => "never",
            Self::ReadOnly | Self::AskForApproval | Self::AutoReview => "on-request",
        }
    }

    fn approvals_reviewer(self) -> &'static str {
        match self {
            Self::AutoReview => "auto_review",
            Self::ReadOnly | Self::AskForApproval | Self::FullAccess => "user",
        }
    }

    fn thread_sandbox(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::AskForApproval | Self::AutoReview => "workspace-write",
            Self::FullAccess => "danger-full-access",
        }
    }

    fn turn_sandbox_policy(self) -> Value {
        match self {
            Self::ReadOnly => json!({"type": "readOnly"}),
            Self::AskForApproval | Self::AutoReview => json!({"type": "workspaceWrite"}),
            Self::FullAccess => json!({"type": "dangerFullAccess"}),
        }
    }

    fn apply_to_thread(self, params: &mut Value) {
        params["approvalPolicy"] = json!(self.approval_policy());
        params["approvalsReviewer"] = json!(self.approvals_reviewer());
        params["sandbox"] = json!(self.thread_sandbox());
    }

    fn apply_to_turn(self, params: &mut Value) {
        params["approvalPolicy"] = json!(self.approval_policy());
        params["approvalsReviewer"] = json!(self.approvals_reviewer());
        params["sandboxPolicy"] = self.turn_sandbox_policy();
    }
}

#[derive(Default)]
pub struct CodexState {
    client: Mutex<Option<Arc<CodexClient>>>,
}

struct CodexClient {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    server_requests: Mutex<HashMap<String, Value>>,
    connected: AtomicBool,
    next_id: AtomicU64,
    events: tokio::sync::broadcast::Sender<Value>,
}

impl CodexClient {
    async fn alive(&self) -> bool {
        if !self.connected.load(Ordering::Acquire) {
            return false;
        }
        self.child
            .lock()
            .await
            .try_wait()
            .is_ok_and(|status| status.is_none())
    }

    async fn send(&self, message: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        encoded.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Cannot write to Codex: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Cannot flush Codex request: {error}"))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .send(json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex closed the connection before responding".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("Codex timed out while handling {method}"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({"method": method, "params": params})).await
    }

    async fn respond(&self, request_id: Value, response: Value) -> Result<(), String> {
        if !request_id.is_string() && !request_id.is_number() {
            return Err("Invalid Codex request id".to_string());
        }
        let key = request_id.to_string();
        let request = self
            .server_requests
            .lock()
            .await
            .remove(&key)
            .ok_or_else(|| "This Codex request is no longer pending".to_string())?;
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if let Err(error) = validate_server_response(method, &response) {
            self.server_requests.lock().await.insert(key, request);
            return Err(error);
        }
        if let Err(error) = self
            .send(json!({"id": request_id, "result": response}))
            .await
        {
            self.server_requests.lock().await.insert(key, request);
            return Err(error);
        }
        Ok(())
    }

    async fn pending_requests(&self) -> Vec<Value> {
        let requests = self.server_requests.lock().await;
        let mut values: Vec<_> = requests.values().cloned().collect();
        values.sort_by_key(|request| request.get("id").map(Value::to_string));
        values
    }
}

fn validate_server_response(method: &str, response: &Value) -> Result<(), String> {
    let valid = match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => matches!(
            response.get("decision").and_then(Value::as_str),
            Some("accept" | "acceptForSession" | "decline" | "cancel")
        ),
        "mcpServer/elicitation/request" => matches!(
            response.get("action").and_then(Value::as_str),
            Some("accept" | "decline" | "cancel")
        ),
        "item/tool/requestUserInput" => response.get("answers").is_some_and(Value::is_object),
        "item/permissions/requestApproval" => {
            response.get("permissions").is_some_and(Value::is_object)
        }
        "item/tool/call" => {
            response.get("success").is_some_and(Value::is_boolean)
                && response.get("contentItems").is_some_and(Value::is_array)
        }
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid Codex response to {method}"))
    }
}

fn spawn_reader(stdout: ChildStdout, client: Weak<CodexClient>, app: AppHandle) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(client) = client.upgrade() else {
                break;
            };

            if message.get("method").and_then(Value::as_str) == Some("serverRequest/resolved") {
                if let Some(request_id) = message
                    .get("params")
                    .and_then(|params| params.get("requestId"))
                {
                    client
                        .server_requests
                        .lock()
                        .await
                        .remove(&request_id.to_string());
                }
            }

            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if message.get("method").is_none() {
                    if let Some(sender) = client.pending.lock().await.remove(&id) {
                        let result = match message.get("error") {
                            Some(error) => Err(format_rpc_error(error)),
                            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = sender.send(result);
                    }
                    continue;
                }
            }

            if let (Some(id), Some(method)) = (message.get("id"), message.get("method")) {
                if method.is_string() {
                    client
                        .server_requests
                        .lock()
                        .await
                        .insert(id.to_string(), message.clone());
                }
            }
            if let (Some(method), Some(id)) = (
                message["method"].as_str(),
                message.pointer("/params/threadId").and_then(Value::as_str),
            ) {
                if method == "turn/started" || method == "turn/completed" {
                    super::writer_bridge::set_busy(&app, "codex", id, method == "turn/started")
                        .await;
                }
            }
            let _ = client.events.send(message.clone());
            let _ = app.emit(EVENT_NAME, &message);
        }

        if let Some(client) = client.upgrade() {
            let _ = client
                .events
                .send(json!({"method":"codex/connectionClosed"}));
            client.connected.store(false, Ordering::Release);
            for (_, sender) in client.pending.lock().await.drain() {
                let _ = sender.send(Err("Codex app-server disconnected".to_string()));
            }
            client.server_requests.lock().await.clear();
        }
        let _ = app.emit(
            EVENT_NAME,
            json!({"method": "codex/connectionClosed", "params": {}}),
        );
    });
}

fn format_rpc_error(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Codex returned an unknown error")
        .to_string()
}

fn default_model(catalog: &Value) -> Result<String, String> {
    let models = catalog
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex returned no model catalog".to_string())?;
    models
        .iter()
        .find(|model| model.get("isDefault").and_then(Value::as_bool) == Some(true))
        .or_else(|| models.first())
        .and_then(|model| model.get("model").or_else(|| model.get("id")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "No Codex models are available for this account".to_string())
}

pub(crate) async fn find_codex_binary() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["codex.exe", "codex.cmd", "codex"]
    } else {
        &["codex"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in names {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    let mut candidates = vec![
        home.join(".local/bin/codex"),
        home.join(".codex/bin/codex"),
        home.join(".bun/bin/codex"),
        home.join(".npm-global/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.insert(0, PathBuf::from(appdata).join("npm/codex.cmd"));
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let node_versions = home.join(".nvm/versions/node");
    let mut versions = tokio::fs::read_dir(node_versions).await.ok()?;
    let mut binaries = Vec::new();
    while let Ok(Some(entry)) = versions.next_entry().await {
        let candidate = entry.path().join("bin/codex");
        if candidate.is_file() {
            binaries.push(candidate);
        }
    }
    binaries.sort();
    binaries.pop()
}

pub(crate) async fn find_node_runtime_directory(binary: &Path) -> Option<PathBuf> {
    let resolved = tokio::fs::canonicalize(binary).await.ok()?;
    let mut candidates = Vec::new();
    if let Some(directory) = binary.parent() {
        candidates.push(directory.to_path_buf());
    }
    if let Some(directory) = resolved.parent() {
        candidates.push(directory.to_path_buf());
        // npm shims commonly point into lib/node_modules. Walk back to the
        // Node installation root, where bin/node lives.
        candidates.extend(directory.ancestors().map(|parent| parent.join("bin")));
    }

    for directory in candidates {
        let node = if cfg!(target_os = "windows") {
            directory.join("node.exe")
        } else {
            directory.join("node")
        };
        if tokio::fs::metadata(node)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            return Some(directory);
        }
    }
    None
}

async fn connect(app: AppHandle) -> Result<Arc<CodexClient>, String> {
    let binary = find_codex_binary()
        .await
        .ok_or_else(|| "Codex CLI is not installed or cannot be found".to_string())?;
    let endpoint = super::writer_bridge::ensure(&app).await?;
    let mut process = command(binary.to_string_lossy().as_ref());
    process
        .arg("-c")
        .arg(format!(
            "mcp_servers.writer_bridge.url={}",
            json!(format!("{}/mcp/codex", endpoint.url))
        ))
        .arg("-c")
        .arg("mcp_servers.writer_bridge.bearer_token_env_var=\"WRITER_MCP_TOKEN\"")
        .env("WRITER_MCP_TOKEN", &endpoint.codex_token);
    // Scope live web search to this Writer process. Search is independent of
    // network access for sandboxed shell commands.
    // The user's global Codex configuration is never changed.
    process
        .arg("-c")
        .arg("web_search=\"live\"")
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    // npm-installed Codex uses `#!/usr/bin/env node`. The Codex shim may be
    // symlinked several times, while a Finder-launched app lacks nvm in PATH.
    if let Some(directory) = find_node_runtime_directory(&binary).await {
        let mut paths = vec![directory];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            process.env("PATH", path);
        }
    }

    let mut child = process
        .spawn()
        .map_err(|error| format!("Cannot launch Codex app-server: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex did not open stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex did not open stdout".to_string())?;
    let client = Arc::new(CodexClient {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        server_requests: Mutex::new(HashMap::new()),
        connected: AtomicBool::new(true),
        next_id: AtomicU64::new(1),
        events: tokio::sync::broadcast::channel(1024).0,
    });
    spawn_reader(stdout, Arc::downgrade(&client), app);
    client
        .request(
            "initialize",
            json!({"clientInfo": {
                "name": "lmms_lab_writer",
                "title": "Y-Writer",
                "version": env!("CARGO_PKG_VERSION")
            }}),
        )
        .await?;
    client.notify("initialized", json!({})).await?;
    Ok(client)
}

async fn ensure_client(state: &CodexState, app: AppHandle) -> Result<Arc<CodexClient>, String> {
    let mut guard = state.client.lock().await;
    if let Some(client) = guard.as_ref() {
        if client.alive().await {
            return Ok(Arc::clone(client));
        }
    }
    let client = connect(app).await?;
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

#[tauri::command]
pub async fn codex_initialize(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_client(&state, app).await?;
    Ok(json!({"connected": true, "webSearch": "live"}))
}

#[tauri::command]
pub async fn codex_list_models(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
) -> Result<Value, String> {
    ensure_client(&state, app)
        .await?
        .request("model/list", json!({"limit": 100}))
        .await
}

#[tauri::command]
pub async fn codex_pending_requests(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
) -> Result<Vec<Value>, String> {
    Ok(ensure_client(&state, app).await?.pending_requests().await)
}

#[tauri::command]
pub async fn codex_start_thread(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    cwd: String,
    model: Option<String>,
    permission_mode: Option<CodexPermissionMode>,
) -> Result<Value, String> {
    let directory = tokio::fs::canonicalize(&cwd)
        .await
        .map_err(|error| format!("Project directory is unavailable: {error}"))?;
    if !tokio::fs::metadata(&directory)
        .await
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("Codex project path must be a directory".to_string());
    }
    let client = ensure_client(&state, app).await?;
    let selected_model = match model.filter(|value| !value.is_empty()) {
        Some(model) => model,
        None => {
            // The user's global model preference may be stale or unavailable
            // for their current ChatGPT subscription. Use this account's live
            // catalog rather than silently inheriting that preference.
            let catalog = client.request("model/list", json!({"limit": 100})).await?;
            default_model(&catalog)?
        }
    };
    let mut params = json!({
        "cwd": directory.to_string_lossy(),
        "model": selected_model,
        "serviceName": "lmms_lab_writer"
    });
    permission_mode
        .unwrap_or_default()
        .apply_to_thread(&mut params);
    client.request("thread/start", params).await
}

#[tauri::command]
pub async fn codex_resume_thread(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    thread_id: String,
    permission_mode: Option<CodexPermissionMode>,
) -> Result<Value, String> {
    let mut params = json!({"threadId": thread_id});
    permission_mode
        .unwrap_or_default()
        .apply_to_thread(&mut params);
    ensure_client(&state, app)
        .await?
        .request("thread/resume", params)
        .await
}

#[tauri::command]
pub async fn codex_list_threads(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    cwd: Option<String>,
    cursor: Option<String>,
) -> Result<Value, String> {
    let mut params = json!({
        "limit": 100,
        "sortKey": "recency_at",
        "sourceKinds": ["appServer", "vscode"]
    });
    if let Some(cursor) = cursor {
        params["cursor"] = Value::String(cursor);
    }
    if let Some(cwd) = cwd {
        let canonical = tokio::fs::canonicalize(&cwd)
            .await
            .map_err(|error| format!("Project directory is unavailable: {error}"))?;
        params["cwd"] = Value::String(canonical.to_string_lossy().into_owned());
    }
    let mut result = ensure_client(&state, app)
        .await?
        .request("thread/list", params)
        .await?;
    if let Some(threads) = result.get_mut("data").and_then(Value::as_array_mut) {
        threads.retain(|thread| {
            thread.get("originator").and_then(Value::as_str) == Some("lmms_lab_writer")
        });
    }
    Ok(result)
}

#[tauri::command]
pub async fn codex_rename_thread(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    thread_id: String,
    name: String,
) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(tr!(
            "对话名称需为 1–120 个字符。",
            "Conversation names must be 1–120 characters."
        )
        .to_string());
    }
    ensure_client(&state, app)
        .await?
        .request(
            "thread/name/set",
            json!({"threadId": thread_id, "name": name}),
        )
        .await
}

#[tauri::command]
pub async fn codex_read_thread(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    thread_id: String,
) -> Result<Value, String> {
    ensure_client(&state, app)
        .await?
        .request(
            "thread/read",
            json!({"threadId": thread_id, "includeTurns": true}),
        )
        .await
}

#[tauri::command]
// Each parameter is one key of the frontend's IPC payload; bundling them would change the contract.
#[allow(clippy::too_many_arguments)]
pub async fn codex_start_turn(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    thread_id: String,
    text: String,
    images: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<CodexPermissionMode>,
) -> Result<Value, String> {
    let text = format!(
        "{}\n{text}",
        super::writer_bridge::context("codex", &thread_id)
    );
    let input = super::chat_images::codex_input(&text, images.unwrap_or_default())?;
    let mut params = json!({
        "threadId": thread_id,
        "input": input
    });
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        params["model"] = Value::String(model);
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        params["effort"] = Value::String(effort);
    }
    // App-server keeps turn-level overrides for subsequent turns on this
    // thread. Sending the selected mode on every message also handles a mode
    // change in an already-resumed conversation without discarding history.
    permission_mode
        .unwrap_or_default()
        .apply_to_turn(&mut params);
    super::writer_bridge::prepare_review(&app, "codex", &thread_id).await;
    let result = ensure_client(&state, app.clone())
        .await?
        .request("turn/start", params)
        .await;
    if result.is_err() {
        let _ = super::reviews::finish(&app, &format!("codex:{thread_id}")).await;
    }
    result
}

#[tauri::command]
pub async fn codex_steer_turn(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    thread_id: String,
    expected_turn_id: String,
    text: String,
    images: Option<Vec<String>>,
) -> Result<Value, String> {
    let input = super::chat_images::codex_input(&text, images.unwrap_or_default())?;
    ensure_client(&state, app)
        .await?
        .request(
            "turn/steer",
            json!({
                "threadId": thread_id, "expectedTurnId": expected_turn_id, "input": input,
                "clientUserMessageId": uuid::Uuid::new_v4().to_string()
            }),
        )
        .await
}

#[tauri::command]
pub async fn codex_interrupt_turn(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    ensure_client(&state, app)
        .await?
        .request(
            "turn/interrupt",
            json!({"threadId": thread_id, "turnId": turn_id}),
        )
        .await
}

#[tauri::command]
pub async fn codex_respond_to_request(
    state: tauri::State<'_, CodexState>,
    app: AppHandle,
    request_id: Value,
    response: Value,
) -> Result<(), String> {
    ensure_client(&state, app)
        .await?
        .respond(request_id, response)
        .await
}

pub async fn bridge_turn(
    app: AppHandle,
    session: super::writer_bridge::Conversation,
    text: String,
) -> Result<String, String> {
    let state = app.state::<CodexState>();
    let client = ensure_client(&state, app.clone()).await?;
    let id = session
        .id
        .strip_prefix("codex:")
        .ok_or(tr!("无效 Codex 会话 ID", "Invalid Codex session ID"))?;
    let mut events = client.events.subscribe();
    let current = client
        .request("thread/read", json!({"threadId":id,"includeTurns":false}))
        .await?;
    if current
        .pointer("/thread/status/type")
        .and_then(Value::as_str)
        == Some("active")
    {
        return Err(tr!(
            "Codex 会话已经在运行，请完成后重新委派",
            "The Codex session is already running; delegate again after it finishes"
        )
        .into());
    }
    let mut params = json!({"threadId":id,"input":[{"type":"text","text":format!("{}\n{text}",super::writer_bridge::context("codex",id))}]});
    for name in ["model", "effort"] {
        if let Some(value) = session.options.get(name).filter(|v| !v.is_null()) {
            params[name] = value.clone();
        }
    }
    let mode: CodexPermissionMode = serde_json::from_value(
        session
            .options
            .get("permissionMode")
            .cloned()
            .unwrap_or(json!("askForApproval")),
    )
    .map_err(|e| e.to_string())?;
    mode.apply_to_turn(&mut params);
    // Delegated turns edit the paper too; record them like turns started from the panel.
    super::reviews::begin_or_report(&app, &session.project, &session.id).await;
    let started = match client.request("turn/start", params).await {
        Ok(started) => started,
        Err(error) => {
            let _ = super::reviews::finish(&app, &session.id).await;
            return Err(error);
        }
    };
    let turn_id = started
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or(tr!("Codex 未返回轮次 ID", "Codex returned no turn ID"))?;
    loop {
        let message = events.recv().await.map_err(|e| {
            trf!(
                "Codex 事件连接中断：{e}",
                "The Codex event connection dropped: {e}"
            )
        })?;
        if message["method"] == "codex/connectionClosed" {
            return Err(tr!(
                "Codex 连接中断；请检查会话历史",
                "The Codex connection dropped; check the conversation history"
            )
            .into());
        }
        if message["method"] == "turn/completed"
            && message.pointer("/params/threadId").and_then(Value::as_str) == Some(id)
            && message.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id)
        {
            let turn = &message["params"]["turn"];
            if turn["status"] != "completed" {
                return Err(trf!(
                    "Codex 任务未完成：{} {}",
                    "The Codex task did not finish: {} {}",
                    turn["status"],
                    turn["error"]
                ));
            }
            let read = client
                .request("thread/read", json!({"threadId":id,"includeTurns":true}))
                .await?;
            let found = read
                .pointer("/thread/turns")
                .and_then(Value::as_array)
                .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id))
                .ok_or(tr!("找不到已完成轮次", "Could not find the finished turn"))?;
            let items = found["items"]
                .as_array()
                .ok_or(tr!("轮次没有结果", "The turn has no result"))?;
            let finals: Vec<_> = items
                .iter()
                .filter(|item| item["type"] == "agentMessage" && item["phase"] == "final_answer")
                .filter_map(|item| item["text"].as_str())
                .collect();
            let result = if finals.is_empty() {
                items
                    .iter()
                    .filter(|item| item["type"] == "agentMessage")
                    .filter_map(|item| item["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            } else {
                finals.join("\n\n")
            };
            return if result.trim().is_empty() {
                Err(tr!(
                    "Codex 已完成但没有文字结果",
                    "Codex finished without a text result"
                )
                .into())
            } else {
                Ok(result.chars().take(40000).collect())
            };
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::find_node_runtime_directory;
    use super::{default_model, validate_server_response, CodexPermissionMode};
    use serde_json::json;

    #[test]
    fn maps_permission_choices_to_codex_thread_and_turn_policies() {
        let cases = [
            ("readOnly", "read-only", "readOnly", "on-request", "user"),
            (
                "askForApproval",
                "workspace-write",
                "workspaceWrite",
                "on-request",
                "user",
            ),
            (
                "autoReview",
                "workspace-write",
                "workspaceWrite",
                "on-request",
                "auto_review",
            ),
            (
                "fullAccess",
                "danger-full-access",
                "dangerFullAccess",
                "never",
                "user",
            ),
        ];

        for (wire_value, sandbox, sandbox_policy_type, approval, reviewer) in cases {
            let mode: CodexPermissionMode = serde_json::from_value(json!(wire_value)).unwrap();
            let mut thread = json!({"threadId": "existing-thread"});
            mode.apply_to_thread(&mut thread);
            assert_eq!(thread["sandbox"], sandbox);
            assert_eq!(thread["approvalPolicy"], approval);
            assert_eq!(thread["approvalsReviewer"], reviewer);
            assert_eq!(thread["threadId"], "existing-thread");

            let mut turn = json!({"threadId": "existing-thread"});
            mode.apply_to_turn(&mut turn);
            assert_eq!(turn["sandboxPolicy"], json!({"type": sandbox_policy_type}));
            assert_eq!(turn["approvalPolicy"], approval);
            assert_eq!(turn["approvalsReviewer"], reviewer);
            assert_eq!(turn["threadId"], "existing-thread");
        }

        assert_eq!(
            CodexPermissionMode::default(),
            CodexPermissionMode::AskForApproval
        );
        assert!(serde_json::from_value::<CodexPermissionMode>(json!("untrusted")).is_err());
    }

    #[test]
    fn uses_account_catalog_default_instead_of_stale_global_model() {
        let catalog = json!({"data": [
            {"model": "gpt-5.6-terra", "isDefault": false},
            {"model": "gpt-5.6-sol", "isDefault": true}
        ]});
        assert_eq!(default_model(&catalog).unwrap(), "gpt-5.6-sol");
        assert!(default_model(&json!({"data": []})).is_err());
    }

    #[test]
    fn validates_approval_response_shapes() {
        assert!(validate_server_response(
            "item/commandExecution/requestApproval",
            &json!({"decision": "accept"})
        )
        .is_ok());
        assert!(validate_server_response(
            "item/fileChange/requestApproval",
            &json!({"decision": "decline"})
        )
        .is_ok());
        assert!(validate_server_response(
            "item/commandExecution/requestApproval",
            &json!({"decision": "acceptAlways"})
        )
        .is_err());
        assert!(
            validate_server_response("item/tool/requestUserInput", &json!({"answers": {}})).is_ok()
        );
        assert!(validate_server_response(
            "item/permissions/requestApproval",
            &json!({"permissions": {}})
        )
        .is_ok());
        assert!(validate_server_response(
            "mcpServer/elicitation/request",
            &json!({"action": "decline"})
        )
        .is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finds_node_behind_nested_npm_symlinks() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let runtime_bin = root.join("versions/node/v24/bin");
        let npm_bin = root.join("versions/node/v24/lib/node_modules/@openai/codex/bin");
        let local_bin = root.join(".local/bin");
        tokio::fs::create_dir_all(&runtime_bin).await.unwrap();
        tokio::fs::create_dir_all(&npm_bin).await.unwrap();
        tokio::fs::create_dir_all(&local_bin).await.unwrap();
        tokio::fs::write(runtime_bin.join("node"), b"")
            .await
            .unwrap();
        tokio::fs::write(npm_bin.join("codex.js"), b"#!/usr/bin/env node\n")
            .await
            .unwrap();
        symlink(npm_bin.join("codex.js"), runtime_bin.join("codex")).unwrap();
        symlink(runtime_bin.join("codex"), local_bin.join("codex")).unwrap();

        assert_eq!(
            find_node_runtime_directory(&local_bin.join("codex")).await,
            Some(tokio::fs::canonicalize(runtime_bin).await.unwrap())
        );
    }
}
