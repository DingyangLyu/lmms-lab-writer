//! Shared identifiers for native harness adapters and annotation dispatch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Harness {
    Codex,
    OpenCode,
    Claude,
}
impl Harness {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::OpenCode),
            "claude" => Ok(Self::Claude),
            _ => Err(format!("不支持的 AI 后端：{value}")),
        }
    }
}
