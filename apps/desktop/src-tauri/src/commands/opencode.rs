use super::util::command;
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child as TokioChild;
use tokio::time::{sleep, timeout, Duration};

const OPENCODE_ENABLE_EXA_ENV: &str = "OPENCODE_ENABLE_EXA";
const OPENCODE_ENABLE_EXA_VALUE: &str = "1";
const PERPLEXITY_API_KEY_ENV: &str = "PERPLEXITY_API_KEY";

pub struct OpenCodeState {
    process: Mutex<Option<ManagedOpenCode>>,
    pub port: Mutex<u16>,
    lifecycle: tokio::sync::Mutex<()>,
}

/// npm launchers can leave a server and MCP children behind when only the
/// launcher is killed. Own a separate process group for this Writer instance.
struct ManagedOpenCode {
    child: TokioChild,
    #[cfg(unix)]
    group_id: Option<u32>,
}

impl ManagedOpenCode {
    fn new(child: TokioChild) -> Self {
        Self {
            #[cfg(unix)]
            group_id: child.id(),
            child,
        }
    }

    #[cfg(unix)]
    fn kill_group(&self, signal: i32) {
        if let Some(id) = self.group_id.filter(|id| *id > 1) {
            // SAFETY: this is the group created for our own child with
            // process_group(0), never a port lookup or the parent's group.
            unsafe {
                libc::kill(-(id as i32), signal);
            }
        }
    }

    async fn terminate(mut self) {
        #[cfg(unix)]
        self.kill_group(libc::SIGTERM);
        #[cfg(not(unix))]
        let _ = self.child.start_kill();
        if timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

impl Deref for ManagedOpenCode {
    type Target = TokioChild;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl DerefMut for ManagedOpenCode {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}
impl Drop for ManagedOpenCode {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.kill_group(libc::SIGKILL);
        let _ = self.child.start_kill();
    }
}

impl Default for OpenCodeState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            port: Mutex::new(4096),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

impl OpenCodeState {
    pub fn shutdown_now(&self) {
        if let Ok(mut process) = self.process.lock() {
            process.take();
        }
    }

    async fn stop_process(&self) -> Result<(), String> {
        let process = self.process.lock().map_err(|e| e.to_string())?.take();
        if let Some(process) = process {
            process.terminate().await;
        }
        Ok(())
    }
    fn process_running(&self) -> Result<bool, String> {
        let mut process = self.process.lock().map_err(|e| e.to_string())?;
        match process.as_mut() {
            Some(child) => match child.try_wait().map_err(|e| e.to_string())? {
                None => Ok(true),
                Some(_) => {
                    *process = None;
                    Ok(false)
                }
            },
            None => Ok(false),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenCodeStatus {
    pub running: bool,
    pub port: u16,
    pub installed: bool,
    pub managed: bool,
    #[serde(rename = "webSearchEnabled")]
    pub web_search_enabled: bool,
}

pub(crate) async fn find_opencode() -> Option<String> {
    let candidates = if cfg!(target_os = "windows") {
        vec!["opencode.cmd", "opencode.exe", "opencode"]
    } else {
        vec!["opencode"]
    };

    // On Windows, use 'where' command; on Unix, use 'which'
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    for candidate in &candidates {
        if let Ok(output) = command(which_cmd).arg(candidate).output().await {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }

    // On Windows, also check common npm/node paths
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm_path = format!("{}\\npm\\opencode.cmd", appdata);
            if std::path::Path::new(&npm_path).exists() {
                return Some(npm_path);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let common_paths: Vec<String> = vec![
            "/opt/homebrew/bin/opencode".to_string(),
            "/usr/local/bin/opencode".to_string(),
            "/usr/bin/opencode".to_string(),
            format!("{}/.local/bin/opencode", home),
            format!("{}/.opencode/bin/opencode", home),
            format!("{}/.bun/bin/opencode", home),
            format!("{}/bin/opencode", home),
        ];

        let result = tokio::task::spawn_blocking(move || {
            common_paths
                .into_iter()
                .find(|path| std::path::Path::new(path).exists())
        })
        .await
        .ok()
        .flatten();

        if result.is_some() {
            return result;
        }
    }

    None
}

#[tauri::command]
pub async fn opencode_status(
    state: tauri::State<'_, OpenCodeState>,
) -> Result<OpenCodeStatus, String> {
    let process_running = state.process_running()?;

    let mut port = *state.port.lock().map_err(|e| e.to_string())?;
    let installed = find_opencode().await.is_some();

    // If no process is tracked by this app, check if daemon is running externally
    let running = if process_running {
        true
    } else if let Some(detected_port) = find_running_opencode_port(4096, 10).await {
        // Found an externally running daemon, update the port
        port = detected_port;
        if let Ok(mut port_guard) = state.port.lock() {
            *port_guard = detected_port;
        }
        true
    } else {
        false
    };

    Ok(OpenCodeStatus {
        running,
        port,
        installed,
        managed: process_running,
        web_search_enabled: process_running,
    })
}

async fn check_port_in_use(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// Check if OpenCode daemon is running on a specific port by making an HTTP request
async fn check_opencode_running_on_port(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/global/health", port);
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .is_some_and(|body| body.get("healthy").and_then(|v| v.as_bool()) == Some(true)),
        _ => false,
    }
}

/// Find a running OpenCode daemon on common ports
async fn find_running_opencode_port(start_port: u16, max_attempts: u16) -> Option<u16> {
    for offset in 0..max_attempts {
        let port = start_port + offset;
        if check_opencode_running_on_port(port).await {
            return Some(port);
        }
    }
    None
}

async fn find_available_port(start_port: u16, max_attempts: u16) -> Option<u16> {
    for offset in 0..max_attempts {
        let Some(port) = start_port.checked_add(offset) else {
            break;
        };
        if port == 0 {
            break;
        }
        if !check_port_in_use(port).await {
            return Some(port);
        }
    }
    // Exhausting the preferred range must not impose a ten-instance limit.
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|addr| addr.port())
}

async fn resolve_env_var(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut shells = Vec::new();
        if let Ok(shell) = std::env::var("SHELL") {
            shells.push(shell);
        }
        shells.push("/bin/zsh".to_string());
        shells.push("/bin/bash".to_string());

        let script = format!("printf %s \"${{{}}}\"", name);
        for shell in shells {
            if !std::path::Path::new(&shell).exists() {
                continue;
            }

            let output = timeout(
                Duration::from_secs(3),
                command(&shell).args(["-ic", &script]).output(),
            )
            .await
            .ok()
            .and_then(Result::ok);

            if let Some(output) = output {
                if !output.status.success() {
                    continue;
                }

                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }

    None
}

#[tauri::command]
pub async fn opencode_start(
    app: AppHandle,
    state: tauri::State<'_, OpenCodeState>,
    directory: String,
    port: Option<u16>,
) -> Result<OpenCodeStatus, String> {
    let _operation = state.lifecycle.lock().await;
    let directory = tokio::fs::canonicalize(&directory)
        .await
        .map_err(|e| format!("Project directory is unavailable: {e}"))?;
    if !tokio::fs::metadata(&directory)
        .await
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Project path is not a directory".into());
    }
    // Every Writer request carries `?directory=`, so one server serves all opened projects.
    // Restarting it for another project would abort sessions still running in the previous one.
    if state.process_running()? {
        let port = *state.port.lock().map_err(|e| e.to_string())?;
        let server = state
            .process
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .and_then(|child| child.id())
            .unwrap_or(0);
        // The shared server is already up; this project still needs its own status watcher.
        super::writer_bridge::monitor_opencode(
            app.clone(),
            server,
            port,
            directory.to_string_lossy().into_owned(),
        );
        return Ok(OpenCodeStatus {
            running: true,
            port,
            installed: true,
            managed: true,
            web_search_enabled: true,
        });
    }
    state.stop_process().await?;
    let opencode_path = find_opencode().await.ok_or("OpenCode not found. Please install it from https://opencode.ai/ or run: npm i -g opencode-ai@latest")?;

    let requested_port = port.unwrap_or(4096);

    // Try to find an available port, starting from the requested port
    let port = find_available_port(requested_port, 10)
        .await
        .ok_or("Cannot allocate a local port for OpenCode")?;

    *state.port.lock().map_err(|e| e.to_string())? = port;

    let perplexity_api_key = resolve_env_var(PERPLEXITY_API_KEY_ENV).await;

    let endpoint = super::writer_bridge::ensure(&app).await?;
    let mut config: serde_json::Value = std::env::var("OPENCODE_CONFIG_CONTENT")
        .ok()
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(|e| format!("Invalid OpenCode inline config: {e}"))?
        .unwrap_or(serde_json::json!({}));
    if config.get("mcp").is_none() {
        config["mcp"] = serde_json::json!({});
    }
    config["mcp"]["writer_bridge"] = serde_json::json!({"type":"remote","url":format!("{}/mcp/opencode",endpoint.url),"headers":{"Authorization":format!("Bearer {}",endpoint.opencode_token)},"enabled":true,"oauth":false});
    let mut opencode_command = command(&opencode_path);
    opencode_command.env("OPENCODE_CONFIG_CONTENT", config.to_string());
    opencode_command
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .current_dir(&directory)
        .env(OPENCODE_ENABLE_EXA_ENV, OPENCODE_ENABLE_EXA_VALUE)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    opencode_command.process_group(0);

    if let Some(key) = &perplexity_api_key {
        opencode_command.env(PERPLEXITY_API_KEY_ENV, key);
    }

    let child = opencode_command
        .spawn()
        .map_err(|e| format!("Failed to spawn OpenCode process: {}", e))?;
    let mut child = ManagedOpenCode::new(child);

    app.emit(
        "opencode-log",
        serde_json::json!({
            "type": "info",
            "message": format!(
                "OpenCode websearch enabled with {}={}",
                OPENCODE_ENABLE_EXA_ENV, OPENCODE_ENABLE_EXA_VALUE
            ),
        }),
    )
    .ok();

    if perplexity_api_key.is_some() {
        app.emit(
            "opencode-log",
            serde_json::json!({
                "type": "info",
                "message": "Perplexity Search API key detected; perplexity_search MCP can use Perplexity as a search backend.",
            }),
        )
        .ok();
    }

    // Spawn tasks to stream stdout/stderr to frontend
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "opencode-log",
                    serde_json::json!({
                        "type": "stdout",
                        "message": line
                    }),
                );
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_clone.emit(
                    "opencode-log",
                    serde_json::json!({
                        "type": "stderr",
                        "message": line
                    }),
                );
            }
        });
    }

    // Wait for the process to start listening on the port
    let start_time = std::time::Instant::now();
    let timeout = Duration::from_secs(30);
    let mut started = false;

    while start_time.elapsed() < timeout {
        // Check if process is still running
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let error_msg = format!(
                "OpenCode exited immediately (exit code: {})\n\
                Path: {}\n\
                Directory: {}\n\n\
                Check the opencode-log events for detailed output.",
                status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                opencode_path,
                directory.display()
            );
            return Err(error_msg);
        }

        // A listening socket alone does not mean the API is ready.
        if check_opencode_running_on_port(port).await {
            started = true;
            break;
        }

        sleep(Duration::from_millis(200)).await;
    }

    if !started {
        // Kill the process if it timed out
        let _ = child.kill().await;
        return Err(format!(
            "OpenCode failed to start within {} seconds (health check failed on port {}).\n\
            Check the opencode-log events for detailed output.",
            timeout.as_secs(),
            port
        ));
    }

    let server = child.id().unwrap_or(0);
    *state.process.lock().map_err(|e| e.to_string())? = Some(child);

    super::writer_bridge::monitor_opencode(
        app.clone(),
        server,
        port,
        directory.to_string_lossy().into_owned(),
    );
    app.emit("opencode-status", "running").ok();

    Ok(OpenCodeStatus {
        running: true,
        port,
        installed: true,
        managed: true,
        web_search_enabled: true,
    })
}

#[tauri::command]
pub async fn opencode_stop(
    app: AppHandle,
    state: tauri::State<'_, OpenCodeState>,
) -> Result<(), String> {
    let _operation = state.lifecycle.lock().await;
    state.stop_process().await?;

    app.emit("opencode-status", "stopped").ok();

    Ok(())
}

#[tauri::command]
pub async fn opencode_restart(
    app: AppHandle,
    state: tauri::State<'_, OpenCodeState>,
    directory: String,
) -> Result<OpenCodeStatus, String> {
    opencode_stop(app.clone(), state.clone()).await.ok();
    sleep(Duration::from_millis(200)).await;
    opencode_start(app, state, directory, None).await
}

#[tauri::command]
pub async fn kill_port_process(port: u16) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = command("cmd")
            .args(["/C", &format!("for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{} ^| findstr LISTENING') do taskkill /F /PID %a", port)])
            .output()
            .await
            .map_err(|e| format!("Failed to run netstat: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.trim().is_empty() {
                return Err(format!("Failed to kill process: {}", stderr));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut pids: Vec<String> = Vec::new();

        if let Ok(lsof_output) = command("lsof")
            .args(["-t", "-i", &format!(":{}", port)])
            .output()
            .await
        {
            if lsof_output.status.success() {
                let raw = String::from_utf8_lossy(&lsof_output.stdout);
                pids = raw.trim().lines().map(|s| s.trim().to_string()).collect();
            }
        }

        #[cfg(target_os = "linux")]
        {
            if pids.is_empty() {
                if let Ok(fuser_output) = command("fuser")
                    .args(["-k", &format!("{}/tcp", port)])
                    .output()
                    .await
                {
                    if fuser_output.status.success() {
                        sleep(Duration::from_millis(500)).await;
                        return Ok(());
                    }
                }
            }
        }

        if pids.is_empty() {
            return Err(format!("No process found on port {}", port));
        }

        for pid in pids {
            if pid.is_empty() {
                continue;
            }
            // Try graceful shutdown first
            let _ = command("kill").args(["-15", &pid]).output().await;
            // Fallback to force kill if needed
            let _ = command("kill").args(["-9", &pid]).output().await;
        }
    }

    sleep(Duration::from_millis(500)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn status_clears_exited_child() {
        let state = OpenCodeState::default();
        let mut child = command("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .unwrap();
        child.wait().await.unwrap();
        *state.process.lock().unwrap() = Some(ManagedOpenCode::new(child));
        assert!(!state.process_running().unwrap());
        assert!(state.process.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn occupied_preferred_range_uses_an_os_assigned_port() {
        use std::net::TcpListener;
        let (start, listeners) = (0..100)
            .find_map(|_| {
                let first = TcpListener::bind(("127.0.0.1", 0)).ok()?;
                let start = first.local_addr().ok()?.port();
                start.checked_add(9)?;
                let mut listeners = vec![first];
                for offset in 1..10 {
                    listeners.push(TcpListener::bind(("127.0.0.1", start + offset)).ok()?);
                }
                Some((start, listeners))
            })
            .expect("reserve ten consecutive local ports");
        let available = find_available_port(start, 10)
            .await
            .expect("OS fallback port");
        assert!(!(start..=start + 9).contains(&available));
        assert_ne!(available, 0);
        let _free = TcpListener::bind(("127.0.0.1", available)).unwrap();
        assert_eq!(listeners.len(), 10);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_removes_a_server_spawned_by_a_launcher() {
        use tokio::io::AsyncBufReadExt;
        let mut launcher = command("/bin/sh").args(["-c", "python3 -u -c 'import socket,time; s=socket.socket(); s.bind((\"127.0.0.1\",0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(60)' & wait"])
            .process_group(0).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let output = launcher.stdout.take().unwrap();
        let managed = ManagedOpenCode::new(launcher);
        let mut lines = BufReader::new(output).lines();
        let port: u16 = timeout(Duration::from_secs(5), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .parse()
            .unwrap();
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok());
        let state = OpenCodeState::default();
        *state.process.lock().unwrap() = Some(managed);
        state.shutdown_now();
        timeout(Duration::from_secs(3), async {
            while check_port_in_use(port).await {
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("grandchild server must release its port on Writer exit");
    }

    #[tokio::test]
    async fn health_check_rejects_unrelated_http_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (body, expected) in [("{}", false), (r#"{"healthy":true}"#, true)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                let read = socket.read(&mut request).await.unwrap();
                assert!(read > 0, "empty health request");
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            assert_eq!(check_opencode_running_on_port(port).await, expected);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn test_find_opencode_returns_valid_path_when_installed() {
        let result = find_opencode().await;

        if let Some(path) = result {
            assert!(
                path.contains("opencode"),
                "Found path should contain 'opencode': {}",
                path
            );
            assert!(
                std::path::Path::new(&path).exists(),
                "Found path should exist: {}",
                path
            );
        }
    }

    #[tokio::test]
    async fn test_find_opencode_never_panics() {
        let result = find_opencode().await;

        if let Some(path) = &result {
            assert!(!path.is_empty());
        }
    }

    #[test]
    fn test_opencode_state_default_has_no_process_and_port_4096() {
        let state = OpenCodeState::default();

        let process = state.process.lock().unwrap();
        assert!(process.is_none(), "Default state should have no process");

        let port = state.port.lock().unwrap();
        assert_eq!(*port, 4096, "Default port should be 4096");
    }

    #[test]
    fn test_opencode_status_roundtrip_serialization() {
        let status = OpenCodeStatus {
            running: true,
            port: 4096,
            installed: true,
            managed: true,
            web_search_enabled: true,
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"running\":true"));
        assert!(json.contains("\"port\":4096"));
        assert!(json.contains("\"installed\":true"));
        assert!(json.contains("\"managed\":true"));
        assert!(json.contains("\"webSearchEnabled\":true"));

        let deserialized: OpenCodeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.running, status.running);
        assert_eq!(deserialized.port, status.port);
        assert_eq!(deserialized.installed, status.installed);
        assert_eq!(deserialized.managed, status.managed);
        assert_eq!(deserialized.web_search_enabled, status.web_search_enabled);
    }
}
