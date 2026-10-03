use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::Path;
const MAX_BYTES: usize = 10 * 1024 * 1024;

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
#[derive(Serialize)]
pub struct ChatImage {
    url: String,
    mime: String,
    filename: String,
}
#[tauri::command]
pub async fn read_chat_image(path: String) -> Result<ChatImage, String> {
    let path = Path::new(&path);
    if !path.is_absolute() {
        return Err("图片路径必须是绝对路径".into());
    }
    let metadata = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES as u64 {
        return Err("请选择小于 10 MB 的图片文件".into());
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let mime = mime(&bytes).ok_or("支持 PNG、JPEG、GIF、WebP 图片")?;
    if bytes.len() > MAX_BYTES {
        return Err("图片超过 10 MB".into());
    }
    Ok(ChatImage {
        url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        mime: mime.into(),
        filename: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    })
}

pub fn codex_input(text: &str, images: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    if images.len() > 6 {
        return Err("一次最多发送 6 张图片".into());
    }
    if text.trim().is_empty() && images.is_empty() {
        return Err("Codex message cannot be empty".into());
    }
    let mut input = Vec::new();
    if !text.trim().is_empty() {
        input.push(serde_json::json!({"type":"text", "text":text}));
    }
    for url in images {
        let (header, encoded) = url.split_once(',').ok_or("无效图片")?;
        if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err("图片超过 10 MB".into());
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| "图片编码无效")?;
        let mime = mime(&bytes).ok_or("图片格式无效")?;
        if bytes.len() > MAX_BYTES || header != format!("data:{mime};base64") {
            return Err("图片格式或大小不正确".into());
        }
        input.push(serde_json::json!({"type":"image", "url":url}));
    }
    Ok(input)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_only_and_text_with_image_preserve_payload() {
        let url = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture")
        );
        assert_eq!(codex_input("", vec![url.clone()]).unwrap()[0]["url"], url);
        let parts = codex_input("Look", vec![url.clone()]).unwrap();
        assert_eq!(parts[0]["text"], "Look");
        assert_eq!(parts[1]["url"], url);
        assert!(codex_input("", vec![]).is_err());
        assert!(codex_input("Look", vec!["file:///secret".into()]).is_err());
        assert!(codex_input("Look", vec![url; 7]).is_err());
    }
}
