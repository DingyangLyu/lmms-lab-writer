//! Bounded project documents and guarded multi-file edits for bibliography/review tools.
use super::{annotations, git_snapshots, saving};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::fs;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub path: String,
    pub content: String,
    pub revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct FileEdit {
    pub path: String,
    pub expected: Option<String>,
    pub content: String,
}
pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub async fn metadata(project: &str, name: &str) -> Result<PathBuf, String> {
    let root = annotations::root(project).await?;
    let mut dir = root.clone();
    for part in [".writer", name] {
        dir.push(part);
        match fs::create_dir(&dir).await {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.to_string()),
        }
        if fs::symlink_metadata(&dir)
            .await
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
            || !fs::canonicalize(&dir)
                .await
                .map_err(|e| e.to_string())?
                .starts_with(&root)
        {
            return Err("项目元数据目录不能是符号链接".into());
        }
    }
    Ok(dir)
}
pub async fn sources(project: &str) -> Result<Vec<SourceFile>, String> {
    let root = annotations::root(project).await?;
    let paths = tokio::task::spawn_blocking(move || {
        let mut paths = vec![];
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(20)
            .into_iter()
            .filter_entry(|e| {
                (e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
                    && ![
                        ".git",
                        ".writer",
                        ".lmms_lab_writer",
                        "node_modules",
                        ".next",
                        "target",
                        "build",
                        "dist",
                        ".cache",
                    ]
                    .contains(&e.file_name().to_string_lossy().as_ref())
            })
        {
            let e = entry.map_err(|e| e.to_string())?;
            if !e.file_type().is_file() {
                continue;
            }
            let ext = e.path().extension().and_then(|e| e.to_str()).unwrap_or("");
            if !["tex", "bib", "md", "txt", "sty", "cls", "bst", "py"].contains(&ext) {
                continue;
            }
            if e.metadata().map_err(|e| e.to_string())?.len() > 2_000_000 {
                return Err(format!("文件过大：{}", e.path().display()));
            }
            paths.push(
                e.path()
                    .strip_prefix(&root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
            if paths.len() > 2000 {
                return Err("项目文本文件超过 2000 个，请缩小工作目录".into());
            }
        }
        paths.sort();
        Ok::<_, String>(paths)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut total = 0;
    let mut files = vec![];
    for path in paths {
        let (_, target) = saving::target_path(project, &path).await?;
        let content = fs::read_to_string(target)
            .await
            .map_err(|e| format!("{path}: {e}"))?;
        total += content.len();
        if total > 32_000_000 {
            return Err("项目文本超过 32 MB，请拆分项目".into());
        }
        files.push(SourceFile {
            revision: hash(&content),
            path,
            content,
        });
    }
    Ok(files)
}
#[tauri::command]
pub async fn writing_list_sources(project: String) -> Result<Vec<SourceFile>, String> {
    sources(&project).await
}

pub async fn apply(project: &str, changes: Vec<FileEdit>, label: &str) -> Result<(), String> {
    if changes.is_empty() || changes.len() > 2000 {
        return Err("修改列表为空或过长".into());
    }
    let _guard = saving::SAVE_LOCK.lock().await;
    let mut prepared = vec![];
    let mut seen = std::collections::HashSet::new();
    for edit in &changes {
        if edit.content.len() > 2_000_000
            || !seen.insert(edit.path.clone())
            || edit.path.starts_with('.')
        {
            return Err("无效文稿修改".into());
        }
        let (_, target) = saving::target_path(project, &edit.path).await?;
        let current = match fs::read_to_string(&target).await {
            Ok(s) => Some(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != edit.expected {
            return Err(format!(
                "{} 已有新的修改，请刷新后重试；尚未覆盖文件。",
                edit.path
            ));
        }
        prepared.push(target);
    }
    git_snapshots::create_snapshot(project, Some(&format!("Writer · {label} · 修改前")), &[])
        .await?;
    let journal = metadata(project, "writing-transactions")
        .await?
        .join(format!("{}.json", uuid::Uuid::new_v4()));
    saving::atomic_write(
        &journal,
        &serde_json::to_vec(&changes).map_err(|e| e.to_string())?,
    )
    .await?;
    let mut written = 0;
    let result = async {
        for (edit, target) in changes.iter().zip(&prepared) {
            let disk = match fs::read_to_string(target).await {
                Ok(s) => Some(s),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.to_string()),
            };
            if disk != edit.expected {
                return Err(format!("{} 在保存时又有变化", edit.path));
            }
            saving::atomic_write(target, edit.content.as_bytes()).await?;
            written += 1;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(cause) = result {
        let mut rollback_errors = vec![];
        for i in (0..written).rev() {
            let edit = &changes[i];
            let target = &prepared[i];
            if fs::read_to_string(target).await.ok().as_deref() != Some(edit.content.as_str()) {
                rollback_errors.push(edit.path.clone());
                continue;
            }
            let restored = match &edit.expected {
                Some(s) => saving::atomic_write(target, s.as_bytes()).await,
                None => fs::remove_file(target).await.map_err(|e| e.to_string()),
            };
            if restored.is_err() {
                rollback_errors.push(edit.path.clone());
            }
        }
        if rollback_errors.is_empty() {
            let _ = fs::remove_file(&journal).await;
        }
        return Err(format!(
            "{cause}；{}",
            if rollback_errors.is_empty() {
                "本次已写入的文件已恢复".into()
            } else {
                format!(
                    "保留外部修改，原文和提案在 {}，需恢复：{}",
                    journal.display(),
                    rollback_errors.join("、")
                )
            }
        ));
    }
    let version =
        git_snapshots::create_snapshot(project, Some(&format!("Writer · {label} · 修改后")), &[])
            .await;
    let _ = fs::remove_file(&journal).await;
    version.map_err(|e| format!("文件已保存，但 Git 版本失败：{e}"))?;
    Ok(())
}
#[tauri::command]
pub async fn writing_apply_changes(
    app: AppHandle,
    project: String,
    changes: Vec<FileEdit>,
    label: String,
) -> Result<(), String> {
    let result = apply(&project, changes, &label).await;
    let _ = app.emit(
        "writer://writing-changed",
        serde_json::json!({"project":project}),
    );
    result
}
#[tauri::command]
pub async fn bibliography_lookup_doi(doi: String) -> Result<String, String> {
    let value = doi.trim().trim_start_matches("https://doi.org/");
    if !value.starts_with("10.")
        || !value.contains('/')
        || value.len() > 300
        || value.chars().any(char::is_whitespace)
    {
        return Err("无效 DOI".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(format!(
            "https://api.crossref.org/works/{}/transform/application/x-bibtex",
            urlencoding::encode(value)
        ))
        .header("User-Agent", "Writer/0.1 bibliography lookup")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("DOI 查询失败：{e}"))?;
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        bytes.extend(chunk);
        if bytes.len() > 100_000 {
            return Err("DOI 返回内容过大".into());
        }
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn bibliography_zotero_local() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for start in (0..2000).step_by(100) {
        let mut response=client.get(format!("http://127.0.0.1:23119/api/users/0/items/top?format=bibtex&limit=100&start={start}"))
            .header("Zotero-API-Version","3").send().await.map_err(|_|"无法连接本机 Zotero。请打开 Zotero 7，并启用本地 API；也可导出 .bib 后导入。")?
            .error_for_status().map_err(|e|e.to_string())?;
        let total = response
            .headers()
            .get("Total-Results")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok());
        while let Some(bytes) = response.chunk().await.map_err(|e| e.to_string())? {
            if result.len() + bytes.len() > 2_000_000 {
                return Err("Zotero 库过大，请按集合导出 BibTeX 导入".into());
            }
            result.extend_from_slice(&bytes);
        }
        result.push(b'\n');
        if total.is_none_or(|n| start + 100 >= n) {
            break;
        }
        if start == 1900 {
            return Err("Zotero 超过 2000 条，请按集合导出后导入".into());
        }
    }
    String::from_utf8(result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stale_batch_keeps_all_files_and_success_creates_versions() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("main.tex"), "\\cite{old}")
            .await
            .unwrap();
        fs::write(dir.path().join("main.bib"), "@book{old,title={A}}")
            .await
            .unwrap();
        let edits = vec![
            FileEdit {
                path: "main.tex".into(),
                expected: Some("\\cite{old}".into()),
                content: "\\cite{new}".into(),
            },
            FileEdit {
                path: "main.bib".into(),
                expected: Some("stale".into()),
                content: "@book{new,title={A}}".into(),
            },
        ];
        assert!(apply(&project, edits.clone(), "rename").await.is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex"))
                .await
                .unwrap(),
            "\\cite{old}"
        );
        let mut edits = edits;
        edits[1].expected = Some("@book{old,title={A}}".into());
        apply(&project, edits, "rename").await.unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("main.tex"))
                .await
                .unwrap(),
            "\\cite{new}"
        );
        assert!(
            git_snapshots::git_snapshot_history(project)
                .await
                .unwrap()
                .len()
                >= 2
        );
    }
    #[tokio::test]
    async fn rejects_outside_project_edits() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        assert!(apply(
            &project,
            vec![FileEdit {
                path: "../outside.tex".into(),
                expected: None,
                content: "bad".into()
            }],
            "test"
        )
        .await
        .is_err());
    }
}
