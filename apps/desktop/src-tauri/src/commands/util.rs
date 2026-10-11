use serde_json::Value;
use std::sync::LazyLock;
use tokio::process::Command as TokioCommand;

/// How Writer starts the agent CLIs (Codex policies, Claude Code arguments), shared with the
/// collaboration server's runner so that a protocol change reaches both hosts.
pub static AGENT_CLI: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../../packages/shared/agent-cli.json"
    ))
    .expect("packages/shared/agent-cli.json is valid JSON")
});

/// Windows CREATE_NO_WINDOW flag to hide console windows
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Extension trait for TokioCommand to hide console windows on Windows
pub trait CommandExt {
    /// Configure the command to hide console window on Windows
    fn hide_window(&mut self) -> &mut Self;
}

impl CommandExt for TokioCommand {
    #[cfg(target_os = "windows")]
    fn hide_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }

    #[cfg(not(target_os = "windows"))]
    fn hide_window(&mut self) -> &mut Self {
        self
    }
}

/// Create a new TokioCommand with hidden window on Windows
pub fn command(program: &str) -> TokioCommand {
    let mut cmd = TokioCommand::new(program);
    cmd.hide_window();
    cmd
}
