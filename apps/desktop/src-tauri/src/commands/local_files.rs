//! Resolve user-clicked local links without treating office artifacts as web pages.
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;
use tokio::fs;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileTarget {
    pub path: String,
    pub project_path: Option<String>,
    pub directory: bool,
}

async fn resolve(project: &str, path: &str) -> Result<(PathBuf, LocalFileTarget), String> {
    if path.is_empty()
        || path.chars().any(char::is_control)
        || path.starts_with("//")
        || path.starts_with("\\\\")
    {
        return Err(tr!("无效的本地文件路径", "Invalid local file path").into());
    }
    let root = fs::canonicalize(project).await.map_err(|e| {
        trf!(
            "无法读取项目目录：{e}",
            "Could not read the project folder: {e}"
        )
    })?;
    let supplied = Path::new(path);
    if !supplied.is_absolute()
        && supplied
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(tr!(
            "请使用项目相对路径或完整的本机绝对路径",
            "Use a path relative to the project or a full absolute path on this computer"
        )
        .into());
    }
    let candidate = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        root.join(supplied)
    };
    let actual = fs::canonicalize(&candidate).await.map_err(|e| {
        trf!(
            "文件不存在或无法访问：{}（{e}）",
            "The file does not exist or cannot be accessed: {} ({e})",
            candidate.display()
        )
    })?;
    let meta = fs::metadata(&actual).await.map_err(|e| e.to_string())?;
    if !meta.is_file() && !meta.is_dir() {
        return Err(tr!(
            "此路径不是普通文件或文件夹",
            "This path is not a regular file or folder"
        )
        .into());
    }
    let project_path = actual
        .strip_prefix(&root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    let target = LocalFileTarget {
        path: actual.to_string_lossy().into_owned(),
        project_path,
        directory: meta.is_dir(),
    };
    Ok((actual, target))
}

#[tauri::command]
pub async fn resolve_local_file(project: String, path: String) -> Result<LocalFileTarget, String> {
    Ok(resolve(&project, &path).await?.1)
}

#[tauri::command]
pub async fn reveal_local_file(
    app: AppHandle,
    project: String,
    path: String,
) -> Result<(), String> {
    let (actual, target) = resolve(&project, &path).await?;
    tokio::task::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        if target.directory {
            app.opener()
                .open_path(actual.to_string_lossy(), None::<&str>)
        } else {
            app.opener().reveal_item_in_dir(actual)
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        trf!(
            "无法在文件管理器中定位：{e}",
            "Could not reveal it in the file manager: {e}"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn resolves_project_artifacts_external_artifacts_and_directories() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("paper");
        fs::create_dir(&root).await.unwrap();
        fs::write(root.join("可编辑 幻灯片.pptx"), b"test")
            .await
            .unwrap();
        fs::write(d.path().join("outside.docx"), b"test")
            .await
            .unwrap();
        let project = root.to_string_lossy();
        let (_, target) = resolve(&project, "可编辑 幻灯片.pptx").await.unwrap();
        assert_eq!(target.project_path.as_deref(), Some("可编辑 幻灯片.pptx"));
        assert!(!target.directory);
        let (_, target) = resolve(&project, &d.path().join("outside.docx").to_string_lossy())
            .await
            .unwrap();
        assert!(target.project_path.is_none());
        assert!(resolve(&project, ".").await.unwrap().1.directory);
        assert!(resolve(&project, "../outside.docx").await.is_err());
        assert!(resolve(&project, "missing.pptx").await.is_err());
        assert!(resolve(&project, "https://example.com/file").await.is_err());
    }
}
