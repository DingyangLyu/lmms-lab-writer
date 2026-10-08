use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, Window};

#[cfg(target_os = "windows")]
fn build_env_path(original: String) -> String {
    if !original.trim().is_empty() {
        return original;
    }

    if let Ok(system_root) = std::env::var("SystemRoot") {
        return format!(r"{}\System32;{}", system_root, system_root);
    }

    r"C:\Windows\System32;C:\Windows".to_string()
}

#[cfg(target_os = "macos")]
fn build_env_path(original: String) -> String {
    const DEFAULT_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

    if original.trim().is_empty() {
        return DEFAULT_PATH.to_string();
    }

    if original.contains("/opt/homebrew/bin") {
        return original;
    }

    format!("{}:{}", DEFAULT_PATH, original)
}

#[cfg(target_os = "linux")]
fn build_env_path(original: String) -> String {
    const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

    if original.trim().is_empty() {
        return DEFAULT_PATH.to_string();
    }

    if original.contains("/usr/local/bin") {
        return original;
    }

    format!("{}:{}", DEFAULT_PATH, original)
}

pub struct PtyInstance {
    /// Label of the window the terminal belongs to.
    pub window: String,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct PtyState {
    pub instances: Arc<Mutex<HashMap<String, PtyInstance>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyOutputEvent {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyExitEvent {
    pub id: String,
    pub code: i32,
}

fn normalize_shell(raw: &str) -> String {
    raw.trim().trim_matches('"').to_string()
}

fn is_executable_available(executable: &str) -> bool {
    let normalized = normalize_shell(executable);
    if normalized.is_empty() {
        return false;
    }

    let executable_path = Path::new(&normalized);
    if executable_path.is_absolute() || normalized.contains(std::path::MAIN_SEPARATOR) {
        return executable_path.is_file();
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };

    #[cfg(target_os = "windows")]
    {
        let has_extension = executable_path.extension().is_some();
        let path_ext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let extensions: Vec<String> = path_ext
            .split(';')
            .filter_map(|ext| {
                let trimmed = ext.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_ascii_lowercase())
                }
            })
            .collect();

        for dir in std::env::split_paths(&path_var) {
            if has_extension {
                if dir.join(&normalized).is_file() {
                    return true;
                }
                continue;
            }

            for ext in &extensions {
                if dir.join(format!("{}{}", normalized, ext)).is_file() {
                    return true;
                }
            }
        }

        false
    }

    #[cfg(not(target_os = "windows"))]
    {
        for dir in std::env::split_paths(&path_var) {
            if dir.join(&normalized).is_file() {
                return true;
            }
        }
        false
    }
}

#[cfg(target_os = "windows")]
fn get_default_shell() -> String {
    if is_executable_available("powershell.exe") {
        return "powershell.exe".to_string();
    }

    if let Ok(comspec) = std::env::var("COMSPEC") {
        let normalized = normalize_shell(&comspec);
        if is_executable_available(&normalized) {
            return normalized;
        }
    }

    if is_executable_available("cmd.exe") {
        return "cmd.exe".to_string();
    }

    "cmd.exe".to_string()
}

#[cfg(target_os = "macos")]
fn get_default_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        let normalized = normalize_shell(&shell);
        if is_executable_available(&normalized) {
            return normalized;
        }
    }

    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if is_executable_available(candidate) {
            return candidate.to_string();
        }
    }

    "/bin/sh".to_string()
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn get_default_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        let normalized = normalize_shell(&shell);
        if is_executable_available(&normalized) {
            return normalized;
        }
    }

    for candidate in ["/bin/bash", "/bin/sh"] {
        if is_executable_available(candidate) {
            return candidate.to_string();
        }
    }

    "/bin/sh".to_string()
}

fn resolve_shell(preferred_shell: Option<String>) -> String {
    if let Some(shell) = preferred_shell {
        let normalized = normalize_shell(&shell);
        if !normalized.is_empty() && is_executable_available(&normalized) {
            return normalized;
        }
    }

    get_default_shell()
}

#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    window: Window,
    state: State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = resolve_shell(shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);

    let env_path = build_env_path(std::env::var("PATH").unwrap_or_default());

    cmd.env("PATH", env_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let id_for_reader = id.clone();
    let id_for_result = id.clone();
    let label = window.label().to_string();
    let target = label.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let event = PtyOutputEvent {
                        id: id_for_reader.clone(),
                        data,
                    };
                    app.emit_to(target.as_str(), "pty-output", event).ok();
                }
                Err(_) => break,
            }
        }
        let exit_event = PtyExitEvent {
            id: id_for_reader.clone(),
            code: 0,
        };
        app.emit_to(target.as_str(), "pty-exit", exit_event).ok();
    });

    let instance = PtyInstance {
        window: label,
        master: pair.master,
        writer,
        child,
    };

    state
        .instances
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), instance);

    Ok(id_for_result)
}

#[tauri::command]
pub async fn write_pty(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut instances = state.instances.lock().map_err(|e| e.to_string())?;

    if let Some(instance) = instances.get_mut(&id) {
        instance
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        instance.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("PTY instance not found: {}", id))
    }
}

#[tauri::command]
pub async fn resize_pty(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let instances = state.instances.lock().map_err(|e| e.to_string())?;

    if let Some(instance) = instances.get(&id) {
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("PTY instance not found: {}", id))
    }
}

#[tauri::command]
pub async fn kill_pty(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut instances = state.instances.lock().map_err(|e| e.to_string())?;

    if let Some(mut instance) = instances.remove(&id) {
        instance.child.kill().ok();
        Ok(())
    } else {
        Err(format!("PTY instance not found: {}", id))
    }
}

/// Ends the terminals of a closed window.
pub fn kill_window(app: &AppHandle, window: &str) {
    let state = app.state::<PtyState>();
    let Ok(mut instances) = state.instances.lock() else {
        return;
    };
    instances.retain(|_, instance| {
        if instance.window != window {
            return true;
        }
        instance.child.kill().ok();
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn unique_temp_file_path(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4()))
    }

    fn create_temp_file(prefix: &str) -> PathBuf {
        let path = unique_temp_file_path(prefix);
        fs::write(&path, b"test shell binary").expect("failed to create temp file");
        path
    }

    #[test]
    fn normalize_shell_trims_whitespace() {
        assert_eq!(normalize_shell("  /bin/bash  "), "/bin/bash");
    }

    #[test]
    fn normalize_shell_removes_quotes() {
        assert_eq!(normalize_shell("\"powershell.exe\""), "powershell.exe");
    }

    #[test]
    fn normalize_shell_clean_input_passthrough() {
        assert_eq!(normalize_shell("/bin/zsh"), "/bin/zsh");
    }

    #[test]
    fn normalize_shell_empty_quotes_returns_empty() {
        assert_eq!(normalize_shell("\"\""), "");
    }

    #[test]
    fn is_executable_available_rejects_empty_input() {
        assert!(!is_executable_available("   "));
    }

    #[test]
    fn is_executable_available_accepts_existing_absolute_file() {
        let file_path = create_temp_file("terminal-exec-available");
        let file_str = file_path.to_string_lossy().to_string();

        assert!(is_executable_available(&file_str));

        fs::remove_file(&file_path).expect("failed to cleanup temp file");
    }

    #[test]
    fn resolve_shell_uses_existing_preferred_path() {
        let file_path = create_temp_file("terminal-resolve-shell");
        let file_str = file_path.to_string_lossy().to_string();

        assert_eq!(resolve_shell(Some(format!("\"{}\"", file_str))), file_str);

        fs::remove_file(&file_path).expect("failed to cleanup temp file");
    }

    #[test]
    fn resolve_shell_falls_back_for_missing_preferred_path() {
        let missing_path = unique_temp_file_path("terminal-missing-shell");
        let missing_str = missing_path.to_string_lossy().to_string();

        assert_eq!(resolve_shell(Some(missing_str)), get_default_shell());
    }

    #[test]
    fn build_env_path_returns_non_empty() {
        let result = build_env_path(String::new());
        assert!(!result.is_empty());
    }

    #[test]
    fn build_env_path_contains_expected_components() {
        let result = build_env_path("/existing/path".to_string());
        assert!(result.contains("/existing/path"));

        #[cfg(target_os = "macos")]
        assert!(result.contains("/opt/homebrew/bin"));

        #[cfg(target_os = "linux")]
        assert!(result.contains("/usr/local/bin"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn build_env_path_keeps_non_empty_windows_path() {
        let original = r"C:\Tools;C:\Windows\System32".to_string();
        assert_eq!(build_env_path(original.clone()), original);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_env_path_empty_uses_macos_defaults_without_trailing_separator() {
        let result = build_env_path(String::new());
        assert_eq!(result, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
        assert!(!result.ends_with(':'));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn build_env_path_empty_uses_linux_defaults_without_trailing_separator() {
        let result = build_env_path(String::new());
        assert_eq!(result, "/usr/local/bin:/usr/bin:/bin");
        assert!(!result.ends_with(':'));
    }
}
