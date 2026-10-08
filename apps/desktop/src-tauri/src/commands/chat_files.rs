//! Durable project-local copies of explicitly selected chat documents.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::{fs, io::AsyncReadExt};
const LIMIT: u64 = 25 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub kind: String,
    pub url: String,
    pub mime: String,
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
fn filename(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().count() > 180
        || name
            .chars()
            .any(|c| c.is_control() || ['/', '\\', ':'].contains(&c))
    {
        return Err(tr!(
            "附件文件名无效或过长",
            "The attachment file name is invalid or too long"
        )
        .into());
    }
    Ok(name.into())
}
fn mime(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "txt" | "tex" | "bib" | "md" | "csv" | "tsv" | "log" => "text/plain",
        "json" => "application/json",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}
async fn directory(root: &Path, parts: &[&str]) -> Result<PathBuf, String> {
    let mut dir = root.to_path_buf();
    for part in parts {
        dir.push(part);
        match fs::create_dir(&dir).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        let meta = fs::symlink_metadata(&dir)
            .await
            .map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(tr!(
                "附件目录不能是链接或普通文件",
                "The attachment folder must not be a link or a regular file"
            )
            .into());
        }
    }
    Ok(dir)
}
async fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .await
        .map_err(|e| trf!("无法读取附件：{e}", "Could not read the attachment: {e}"))?;
    let meta = file.metadata().await.map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > LIMIT {
        return Err(tr!(
            "请选择不超过 25 MB 的普通文件；文件夹请先压缩。",
            "Choose a regular file of 25 MB or less; compress folders first."
        )
        .into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err(tr!("附件超过 25 MB", "The attachment is over 25 MB").into());
    }
    Ok(bytes)
}
/// Copies are content-addressed; read-only keeps editors and agents from changing them.
async fn read_only(target: &Path) -> Result<(), String> {
    let mut permissions = fs::metadata(target)
        .await
        .map_err(|e| e.to_string())?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(target, permissions)
        .await
        .map_err(|e| e.to_string())
}
async fn write_copy(target: &Path, bytes: &[u8]) -> Result<(), String> {
    super::saving::atomic_write(target, bytes).await?;
    read_only(target).await
}
async fn stage(project: &str, name: &str, bytes: &[u8]) -> Result<ChatFile, String> {
    if bytes.len() as u64 > LIMIT {
        return Err(tr!("附件超过 25 MB", "The attachment is over 25 MB").into());
    }
    let name = filename(name)?;
    let root = super::annotations::root(project).await?;
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    let dir = directory(&root, &[".writer", "attachments", &sha256]).await?;
    let target = dir.join(&name);
    if fs::try_exists(&target).await.map_err(|e| e.to_string())? {
        let meta = fs::symlink_metadata(&target)
            .await
            .map_err(|e| e.to_string())?;
        let intact = meta.is_file()
            && !meta.file_type().is_symlink()
            && bounded_read(&target).await.ok().as_deref() == Some(bytes);
        if !intact {
            // An editor or agent changed the copy in place. Keep that version aside and
            // restore the content this directory is named after, so history opens it again.
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let aside = directory(
                &root,
                &[
                    ".writer",
                    "attachments",
                    &sha256,
                    &format!("modified-{stamp}"),
                ],
            )
            .await?;
            fs::rename(&target, aside.join(&name)).await.map_err(|e| {
                trf!(
                    "附件副本已改变且无法移开：{e}",
                    "The attachment copy changed and could not be moved aside: {e}"
                )
            })?;
            write_copy(&target, bytes).await?;
        } else if !meta.permissions().readonly() {
            read_only(&target).await?;
        }
    } else {
        write_copy(&target, bytes).await?;
    }
    let path = format!(".writer/attachments/{sha256}/{name}");
    Ok(ChatFile {
        kind: "document".into(),
        url: url::Url::from_file_path(&target)
            .map_err(|_| tr!("附件路径无效", "Invalid attachment path"))?
            .into(),
        mime: mime(&name).into(),
        filename: name,
        path,
        size: bytes.len() as u64,
        sha256,
    })
}
#[tauri::command]
pub async fn import_chat_file(project: String, path: String) -> Result<ChatFile, String> {
    let source = Path::new(&path);
    if !source.is_absolute() {
        return Err(tr!(
            "附件路径必须为绝对路径",
            "The attachment path must be absolute"
        )
        .into());
    }
    let name = source
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(tr!("附件文件名无效", "Invalid attachment file name"))?;
    stage(&project, name, &bounded_read(source).await?).await
}
#[tauri::command]
pub async fn import_chat_file_data(
    project: String,
    name: String,
    base64: String,
) -> Result<ChatFile, String> {
    if base64.len() > LIMIT.div_ceil(3) as usize * 4 {
        return Err(tr!("附件超过 25 MB", "The attachment is over 25 MB").into());
    }
    let bytes = STANDARD
        .decode(base64)
        .map_err(|_| tr!("附件编码无效", "Invalid attachment encoding"))?;
    stage(&project, &name, &bytes).await
}
#[tauri::command]
pub async fn validate_chat_files(
    project: String,
    files: Vec<ChatFile>,
) -> Result<Vec<ChatFile>, String> {
    if files.len() > 6 {
        return Err(tr!(
            "一次最多发送 6 个附件",
            "Send at most 6 attachments at a time"
        )
        .into());
    }
    let root = super::annotations::root(&project).await?;
    for file in &files {
        let name = filename(&file.filename)?;
        if file.kind != "document"
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || file.path != format!(".writer/attachments/{}/{name}", file.sha256)
        {
            return Err(tr!(
                "附件引用无效，请重新添加。",
                "Invalid attachment reference; add it again."
            )
            .into());
        }
        let target = super::annotations::project_file(&root, &file.path).await?;
        let bytes = bounded_read(&target).await?;
        if format!("{:x}", Sha256::digest(&bytes)) != file.sha256 || bytes.len() as u64 != file.size
        {
            return Err(trf!(
                "附件 {} 已改变，请重新添加。",
                "The attachment {} changed; add it again.",
                name
            ));
        }
    }
    Ok(files)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn selected_file_is_copied_and_survives_source_removal() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("paper");
        fs::create_dir(&project).await.unwrap();
        let source = dir.path().join("中文 资料.pdf");
        fs::write(&source, b"%PDF fixture").await.unwrap();
        let file = import_chat_file(
            project.to_string_lossy().into(),
            source.to_string_lossy().into(),
        )
        .await
        .unwrap();
        fs::remove_file(source).await.unwrap();
        assert!(file.url.contains("%"));
        assert!(
            validate_chat_files(project.to_string_lossy().into(), vec![file])
                .await
                .is_ok()
        );
    }
    #[tokio::test]
    async fn isolates_same_named_files_and_detects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        let a = stage(p, "notes.txt", b"first").await.unwrap();
        let b = stage(p, "notes.txt", b"second").await.unwrap();
        assert_ne!(a.path, b.path);
        assert_eq!(stage(p, "notes.txt", b"first").await.unwrap().path, a.path);
        let copy = dir.path().join(&a.path);
        assert!(fs::metadata(&copy).await.unwrap().permissions().readonly());
        let mut writable = fs::metadata(&copy).await.unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        writable.set_readonly(false);
        fs::set_permissions(&copy, writable).await.unwrap();
        fs::write(&copy, b"changed").await.unwrap();
        assert!(validate_chat_files(p.into(), vec![a.clone()])
            .await
            .is_err());
        // Adding the original again restores the copy and keeps the edited version aside.
        assert_eq!(stage(p, "notes.txt", b"first").await.unwrap().path, a.path);
        assert_eq!(fs::read(&copy).await.unwrap(), b"first");
        assert!(validate_chat_files(p.into(), vec![a]).await.is_ok());
        let mut aside = fs::read_dir(copy.parent().unwrap()).await.unwrap();
        let mut kept = false;
        while let Some(entry) = aside.next_entry().await.unwrap() {
            if entry.file_name().to_string_lossy().starts_with("modified-") {
                kept = fs::read(entry.path().join("notes.txt")).await.unwrap() == b"changed";
            }
        }
        assert!(kept);
        assert!(stage(p, "../bad", b"").await.is_err());
    }
    #[tokio::test]
    async fn rejects_directories_and_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        assert!(import_chat_file(p.clone(), p.clone()).await.is_err());
        let f = dir.path().join("large.zip");
        fs::File::create(&f)
            .await
            .unwrap()
            .set_len(LIMIT + 1)
            .await
            .unwrap();
        assert!(import_chat_file(p, f.to_string_lossy().into())
            .await
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_an_attachment_directory_pointing_outside_project() {
        let dir = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(out.path(), dir.path().join(".writer")).unwrap();
        assert!(stage(dir.path().to_str().unwrap(), "test.txt", b"test")
            .await
            .is_err());
    }
}
