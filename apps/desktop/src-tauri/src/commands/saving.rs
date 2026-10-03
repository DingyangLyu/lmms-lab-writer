use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub(crate) static SAVE_LOCK: Mutex<()> = Mutex::const_new(());
const HISTORY_LIMIT: usize = 30;

#[derive(Default)]
pub struct SaveGuard {
    pub ready: AtomicBool,
    pub approved: AtomicBool,
}

#[tauri::command]
pub fn register_save_guard(state: State<'_, SaveGuard>) {
    state.ready.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn finish_close(app: AppHandle, state: State<'_, SaveGuard>) {
    state.approved.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub(crate) async fn target_path(
    project: &str,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(project).await.map_err(|e| e.to_string())?;
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Invalid project-relative file path".into());
    }
    let target = root.join(relative);
    let target = if fs::try_exists(&target).await.map_err(|e| e.to_string())? {
        fs::canonicalize(target).await.map_err(|e| e.to_string())?
    } else {
        let parent = fs::canonicalize(target.parent().ok_or("Invalid file path")?)
            .await
            .map_err(|e| e.to_string())?;
        parent.join(target.file_name().ok_or("Invalid file name")?)
    };
    if !target.starts_with(&root) {
        return Err("File is outside the project".into());
    }
    Ok((root, target))
}

/// Stage and sync the entire file before replacing the previous version.
/// Failed writes never truncate the user's original file.
pub async fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid file path")?;
    let permissions = match fs::metadata(path).await {
        Ok(metadata) => {
            if metadata.permissions().readonly() {
                return Err("文件为只读，无法保存。请另存副本或恢复写入权限。".into());
            }
            Some(metadata.permissions())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let temp = parent.join(format!(".lmms-save-{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp).await.map_err(|e| e.to_string())?;
        file.write_all(content).await.map_err(|e| e.to_string())?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)
                .await
                .map_err(|e| e.to_string())?;
        }
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).await.map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            let parent = parent.to_path_buf();
            tokio::task::spawn_blocking(move || std::fs::File::open(parent)?.sync_all())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(temp).await;
    }
    result
}

async fn history_dir(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let relative = target.strip_prefix(root).map_err(|e| e.to_string())?;
    let dir = root.join(".lmms_lab_writer").join("backups").join(relative);
    // Validate each existing ancestor before creating directories (including symlinks).
    let mut ancestor = dir.as_path();
    while !fs::try_exists(ancestor).await.map_err(|e| e.to_string())? {
        ancestor = ancestor.parent().ok_or("Invalid backup path")?;
    }
    if !fs::canonicalize(ancestor)
        .await
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("Backup folder is outside the project".into());
    }
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("无法创建备份目录，原文件未覆盖：{}", e))?;
    Ok(dir)
}

#[derive(Serialize)]
pub struct Backup {
    id: String,
    timestamp: u64,
    bytes: u64,
}

async fn backups(dir: &Path) -> Result<Vec<Backup>, String> {
    let mut entries = fs::read_dir(dir).await.map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let id = entry.file_name().to_string_lossy().to_string();
        if !id.ends_with(".bak")
            || !entry
                .file_type()
                .await
                .map_err(|e| e.to_string())?
                .is_file()
        {
            continue;
        }
        if let Some(timestamp) = id.split('-').next().and_then(|s| s.parse().ok()) {
            result.push(Backup {
                id,
                timestamp,
                bytes: entry.metadata().await.map_err(|e| e.to_string())?.len(),
            });
        }
    }
    result.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(result)
}

pub(crate) async fn create_backup(
    root: &Path,
    target: &Path,
    content: &str,
) -> Result<PathBuf, String> {
    let dir = history_dir(root, target).await?;
    if let Ok(items) = backups(&dir).await {
        if let Some(latest) = items.first() {
            if fs::read_to_string(dir.join(&latest.id))
                .await
                .ok()
                .as_deref()
                == Some(content)
            {
                return Ok(dir);
            }
        }
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let backup = dir.join(format!("{}-{}.bak", timestamp, uuid::Uuid::new_v4()));
    atomic_write(&backup, content.as_bytes())
        .await
        .map_err(|e| format!("备份失败，操作已取消：{}", e))?;
    if let Ok(items) = backups(&dir).await {
        for old in items.iter().skip(HISTORY_LIMIT) {
            let _ = fs::remove_file(dir.join(&old.id)).await;
        }
    }
    Ok(dir)
}

/// Preserve the exact source before a selection-based agent edit.
#[tauri::command]
pub async fn checkpoint_document(
    project: String,
    path: String,
    expected: String,
) -> Result<(), String> {
    let _guard = SAVE_LOCK.lock().await;
    let (root, target) = target_path(&project, &path).await?;
    let content = fs::read_to_string(&target)
        .await
        .map_err(|e| e.to_string())?;
    if content != expected {
        return Err("选区文件已变化，请重新选择后再发送。".into());
    }
    let dir = create_backup(&root, &target, &content).await?;
    if fs::read_to_string(&target)
        .await
        .map_err(|e| e.to_string())?
        != content
    {
        return Err("备份期间文件已变化，请重新选择后再发送。".into());
    }
    if let Ok(items) = backups(&dir).await {
        for old in items.iter().skip(HISTORY_LIMIT) {
            let _ = fs::remove_file(dir.join(&old.id)).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_document_backups(project: String, path: String) -> Result<Vec<Backup>, String> {
    let (root, target) = target_path(&project, &path).await?;
    backups(&history_dir(&root, &target).await?).await
}

#[tauri::command]
pub async fn read_document_backup(
    project: String,
    path: String,
    id: String,
) -> Result<String, String> {
    let (root, target) = target_path(&project, &path).await?;
    if id.contains(['/', '\\']) || !id.ends_with(".bak") {
        return Err("Invalid backup ID".into());
    }
    let dir = history_dir(&root, &target).await?;
    let target = fs::canonicalize(dir.join(id))
        .await
        .map_err(|e| e.to_string())?;
    if !target.starts_with(&dir) {
        return Err("Invalid backup path".into());
    }
    fs::read_to_string(target).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_document_copy(path: String, content: String) -> Result<(), String> {
    // The frontend uses a native Save dialog. Refuse existing files so recovery never overwrites them.
    let target = Path::new(&path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(target).await.map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_document(project: String, path: String) -> Result<String, String> {
    let (_, target) = target_path(&project, &path).await?;
    fs::read_to_string(target).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Editor saves go through the merging save; these checks cover its file safety.
    async fn save_document(
        project: String,
        path: String,
        content: String,
        expected: String,
    ) -> Result<(), String> {
        let result = super::super::document_merge::save(
            &project, &path, &expected, &content, "editor", None,
        )
        .await?;
        if result.status == "saved" {
            Ok(())
        } else {
            Err(format!("已停止覆盖：{}", result.status))
        }
    }
    async fn project() -> (tempfile::TempDir, String, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_string_lossy().to_string();
        let file = temp.path().join("main.tex");
        fs::write(&file, "原稿").await.unwrap();
        (temp, root, file)
    }
    #[tokio::test]
    async fn agent_checkpoint_backs_up_without_modifying_document() {
        let (_temp, root, file) = project().await;
        checkpoint_document(root.clone(), "main.tex".into(), "原稿".into())
            .await
            .unwrap();
        checkpoint_document(root.clone(), "main.tex".into(), "原稿".into())
            .await
            .unwrap();
        let items = list_document_backups(root.clone(), "main.tex".into())
            .await
            .unwrap();
        assert_eq!(
            items.len(),
            1,
            "Unchanged checkpoints should not evict useful history"
        );
        assert_eq!(fs::read_to_string(&file).await.unwrap(), "原稿");
        assert_eq!(
            read_document_backup(root, "main.tex".into(), items[0].id.clone())
                .await
                .unwrap(),
            "原稿"
        );
    }

    #[tokio::test]
    async fn agent_checkpoint_rejects_a_stale_file_snapshot() {
        let (_temp, root, file) = project().await;
        fs::write(&file, "其他修改").await.unwrap();
        assert!(checkpoint_document(root, "main.tex".into(), "原稿".into())
            .await
            .is_err());
        assert_eq!(fs::read_to_string(file).await.unwrap(), "其他修改");
    }

    #[tokio::test]
    async fn save_preserves_previous_version_and_utf8() {
        let (_temp, root, file) = project().await;
        save_document(
            root.clone(),
            "main.tex".into(),
            "新版中文 ✨".into(),
            "原稿".into(),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(file).await.unwrap(), "新版中文 ✨");
        let history = list_document_backups(root.clone(), "main.tex".into())
            .await
            .unwrap();
        let mut saved = vec![];
        for item in &history {
            saved.push(
                read_document_backup(root.clone(), "main.tex".into(), item.id.clone())
                    .await
                    .unwrap(),
            );
        }
        assert!(saved.contains(&"原稿".to_string()));
        assert!(saved.contains(&"新版中文 ✨".to_string()));
    }
    #[tokio::test]
    async fn external_edit_is_not_overwritten() {
        let (_temp, root, file) = project().await;
        fs::write(&file, "AI 修改").await.unwrap();
        assert!(
            save_document(root, "main.tex".into(), "我的修改".into(), "原稿".into())
                .await
                .unwrap_err()
                .contains("已停止覆盖")
        );
        assert_eq!(fs::read_to_string(file).await.unwrap(), "AI 修改");
    }
    #[tokio::test]
    async fn failed_backup_leaves_original_intact() {
        let (temp, root, file) = project().await;
        fs::write(temp.path().join(".lmms_lab_writer"), "blocked")
            .await
            .unwrap();
        assert!(
            save_document(root, "main.tex".into(), "new".into(), "原稿".into())
                .await
                .is_err()
        );
        assert_eq!(fs::read_to_string(file).await.unwrap(), "原稿");
    }
    #[tokio::test]
    async fn deleted_file_is_not_silently_recreated() {
        let (_temp, root, file) = project().await;
        fs::remove_file(&file).await.unwrap();
        assert!(
            save_document(root, "main.tex".into(), "new".into(), "原稿".into())
                .await
                .is_err()
        );
        assert!(!file.exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn readonly_file_is_preserved() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, root, file) = project().await;
        fs::set_permissions(&file, std::fs::Permissions::from_mode(0o444))
            .await
            .unwrap();
        assert!(
            save_document(root, "main.tex".into(), "new".into(), "原稿".into())
                .await
                .is_err()
        );
        assert_eq!(fs::read_to_string(&file).await.unwrap(), "原稿");
        fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644))
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn history_keeps_recent_thirty_versions() {
        let (_temp, root, _) = project().await;
        let mut old = "原稿".to_string();
        for index in 0..33 {
            let new = format!("version {}", index);
            save_document(root.clone(), "main.tex".into(), new.clone(), old)
                .await
                .unwrap();
            old = new;
        }
        assert_eq!(
            list_document_backups(root, "main.tex".into())
                .await
                .unwrap()
                .len(),
            30
        );
    }
    #[tokio::test]
    async fn recovery_copy_cannot_overwrite_an_existing_file() {
        let (temp, _root, file) = project().await;
        assert!(
            export_document_copy(file.to_string_lossy().to_string(), "new".into())
                .await
                .is_err()
        );
        assert_eq!(fs::read_to_string(&file).await.unwrap(), "原稿");
        let copy = temp.path().join("recovered.txt");
        export_document_copy(copy.to_string_lossy().to_string(), "恢复内容".into())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(copy).await.unwrap(), "恢复内容");
    }
    #[tokio::test]
    async fn rejects_path_traversal() {
        let (_temp, root, _) = project().await;
        assert!(
            save_document(root.clone(), "../outside".into(), "new".into(), "".into())
                .await
                .is_err()
        );
        assert!(
            read_document_backup(root, "main.tex".into(), "../../outside.bak".into())
                .await
                .is_err()
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_symlink_target_and_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (temp, root, file) = project().await;
        fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640))
            .await
            .unwrap();
        symlink(&file, temp.path().join("alias.tex")).unwrap();
        save_document(root, "alias.tex".into(), "new".into(), "原稿".into())
            .await
            .unwrap();
        assert!(fs::symlink_metadata(temp.path().join("alias.tex"))
            .await
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&file).await.unwrap(), "new");
        assert_eq!(
            fs::metadata(&file).await.unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
