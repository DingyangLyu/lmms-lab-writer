//! Disk side of the folder sync (packages/sync): which files are shared, compare-and-swap
//! writes, and the per-folder link and sync state under `.writer/sync/`.
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// Never shared: app data, dependencies, caches and the usual build directories.
const SKIPPED_DIRS: &[&str] = &["node_modules", "__pycache__", "dist", "build", "out"];
/// LaTeX intermediates; collaborators compile for themselves.
const GENERATED: &[&str] = &[
    ".aux",
    ".log",
    ".synctex.gz",
    ".fdb_latexmk",
    ".fls",
    ".out",
    ".toc",
    ".lof",
    ".lot",
    ".bbl",
    ".blg",
    ".bcf",
    ".run.xml",
    ".xdv",
    ".dvi",
    ".nav",
    ".snm",
    ".vrb",
    ".idx",
    ".ilg",
    ".ind",
    ".glo",
    ".gls",
    ".glg",
    ".ist",
    ".acn",
    ".acr",
    ".alg",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncLink {
    pub server: String,
    pub project: String,
    pub name: String,
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A project-relative path with "/" separators and no hidden or parent segments.
fn relative(path: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = path.split('/').collect();
    if path.is_empty()
        || path.len() > 240
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(|c| c.is_control())
        || parts.iter().any(|p| p.is_empty() || p.starts_with('.'))
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("无效的同步路径：{path}"));
    }
    Ok(parts.iter().collect())
}

/// The file inside `root`; refuses links that lead outside the project.
async fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let target = root.join(relative(path)?);
    if let Ok(meta) = tokio::fs::symlink_metadata(&target).await {
        if meta.file_type().is_symlink() {
            return Err(format!("同步不处理符号链接：{path}"));
        }
    }
    let mut ancestor = target.parent().ok_or("无效路径")?.to_path_buf();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("无效路径")?.to_path_buf();
    }
    let canonical = tokio::fs::canonicalize(&ancestor)
        .await
        .map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("路径指向项目外部".into());
    }
    Ok(target)
}

async fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// True when the file holds content with this SHA-256 (or is absent and `expected` is None).
async fn holds(path: &Path, expected: &Option<String>) -> Result<bool, String> {
    let current = read_bytes(path).await?;
    Ok(match (current, expected) {
        (None, None) => true,
        (Some(bytes), Some(hash)) => &hex(&bytes) == hash,
        _ => false,
    })
}

/// Build outputs named in `.writer/latex.json`: whole output directories, and the PDF of a
/// target that builds next to its sources.
async fn build_outputs(root: &Path) -> (Vec<String>, Vec<String>) {
    let (mut dirs, mut files) = (vec![], vec![]);
    let Ok(text) = tokio::fs::read(root.join(".writer/latex.json")).await else {
        return (dirs, files);
    };
    let Ok(config) = serde_json::from_slice::<super::latex_project::ProjectConfig>(&text) else {
        return (dirs, files);
    };
    for target in config.targets {
        let output = target.output_dir.trim_matches('/').to_string();
        let stem = Path::new(&target.main_file)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if output.is_empty() || output == "." {
            let dir = Path::new(&target.main_file)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            files.push(if dir.is_empty() {
                format!("{stem}.pdf")
            } else {
                format!("{dir}/{stem}.pdf")
            });
        } else {
            dirs.push(format!("{output}/"));
            files.push(format!("{output}/{stem}.pdf"));
        }
    }
    (dirs, files)
}

pub async fn list(root: &Path) -> Result<Vec<String>, String> {
    let (output_dirs, output_files) = build_outputs(root).await;
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut walk = ignore::WalkBuilder::new(&root);
        walk.hidden(true)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(false)
            .require_git(false)
            .add_custom_ignore_filename(".writerignore")
            .follow_links(false)
            .filter_entry(|entry| {
                !entry.file_type().is_some_and(|t| t.is_dir())
                    || !SKIPPED_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
            });
        let mut files = vec![];
        for entry in walk.build().flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(relative) = entry.path().strip_prefix(&root) else {
                continue;
            };
            let path = relative.to_string_lossy().replace('\\', "/");
            let lower = path.to_lowercase();
            if GENERATED.iter().any(|ext| lower.ends_with(ext))
                || output_dirs.iter().any(|dir| path.starts_with(dir))
                || output_files.contains(&path)
            {
                continue;
            }
            files.push(path);
        }
        files.sort();
        files
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_list(project: String) -> Result<Vec<String>, String> {
    list(&super::annotations::root(&project).await?).await
}

/// File content as base64, or null when the file does not exist.
#[tauri::command]
pub async fn sync_read(project: String, path: String) -> Result<Option<String>, String> {
    let root = super::annotations::root(&project).await?;
    let file = inside(&root, &path).await?;
    Ok(read_bytes(&file)
        .await?
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Writes only if the file still has the expected SHA-256 (None: must not exist).
#[tauri::command]
pub async fn sync_write(
    project: String,
    path: String,
    data: String,
    expected: Option<String>,
) -> Result<bool, String> {
    let root = super::annotations::root(&project).await?;
    let file = inside(&root, &path).await?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    if !holds(&file, &expected).await? {
        return Ok(false);
    }
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    super::saving::atomic_write(&file, &bytes).await?;
    Ok(true)
}

#[tauri::command]
pub async fn sync_remove(project: String, path: String, expected: String) -> Result<bool, String> {
    let root = super::annotations::root(&project).await?;
    let file = inside(&root, &path).await?;
    if !holds(&file, &Some(expected)).await? {
        return Ok(false);
    }
    tokio::fs::remove_file(&file)
        .await
        .map_err(|e| e.to_string())?;
    prune_empty(&root, &file).await;
    Ok(true)
}

/// Removes the directories a deleted or moved file left empty, up to the project root.
async fn prune_empty(root: &Path, file: &Path) {
    let mut dir = file.parent().map(Path::to_path_buf);
    while let Some(current) = dir {
        if current == root || tokio::fs::remove_dir(&current).await.is_err() {
            break;
        }
        dir = current.parent().map(Path::to_path_buf);
    }
}

/// Moves a file unless the destination exists.
#[tauri::command]
pub async fn sync_move(project: String, from: String, to: String) -> Result<bool, String> {
    let root = super::annotations::root(&project).await?;
    let source = inside(&root, &from).await?;
    let target = inside(&root, &to).await?;
    if read_bytes(&source).await?.is_none() || tokio::fs::symlink_metadata(&target).await.is_ok() {
        return Ok(false);
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::rename(&source, &target)
        .await
        .map_err(|e| e.to_string())?;
    prune_empty(&root, &source).await;
    Ok(true)
}

async fn sync_file(project: &str, name: &str) -> Result<PathBuf, String> {
    let root = super::annotations::root(project).await?;
    Ok(super::latex_project::writable_dir(&root, ".writer/sync")
        .await?
        .join(name))
}

#[tauri::command]
pub async fn sync_state_load(project: String) -> Result<Option<String>, String> {
    let bytes = read_bytes(&sync_file(&project, "state.json").await?).await?;
    Ok(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
}

#[tauri::command]
pub async fn sync_state_save(project: String, data: String) -> Result<(), String> {
    super::saving::atomic_write(&sync_file(&project, "state.json").await?, data.as_bytes()).await
}

#[tauri::command]
pub async fn sync_link_get(project: String) -> Result<Option<SyncLink>, String> {
    let Some(bytes) = read_bytes(&sync_file(&project, "link.json").await?).await? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Links a folder to a server project, or unlinks it (the sync state goes with the link).
#[tauri::command]
pub async fn sync_link_set(project: String, link: Option<SyncLink>) -> Result<(), String> {
    let file = sync_file(&project, "link.json").await?;
    match link {
        Some(link) => {
            let json = serde_json::to_vec_pretty(&link).map_err(|e| e.to_string())?;
            super::saving::atomic_write(&file, &json).await
        }
        None => {
            let _ = tokio::fs::remove_file(&file).await;
            let _ = tokio::fs::remove_file(sync_file(&project, "state.json").await?).await;
            Ok(())
        }
    }
}

/// Creates `parent/name` for a project opened from a server; it must not exist yet.
#[tauri::command]
pub async fn sync_create_folder(parent: String, name: String) -> Result<String, String> {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if clean.is_empty() {
        return Err("无效的文件夹名".into());
    }
    let parent = tokio::fs::canonicalize(&parent)
        .await
        .map_err(|e| e.to_string())?;
    let folder = parent.join(&clean);
    tokio::fs::create_dir(&folder)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("“{clean}”已存在，请选择别的位置"),
            _ => e.to_string(),
        })?;
    Ok(folder.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_sources_but_not_outputs_ignored_or_private_files() {
        let d = tempfile::tempdir().unwrap();
        let root = tokio::fs::canonicalize(d.path()).await.unwrap();
        for (path, text) in [
            ("main.tex", "x"),
            ("main.pdf", "built next to the source"),
            ("main.aux", "x"),
            ("figures/plot.pdf", "a figure"),
            ("output/en/main.pdf", "x"),
            ("notes/scratch.txt", "x"),
            (
                ".writer/latex.json",
                r#"{"version":1,"activeTarget":"a","targets":[
                {"id":"a","name":"a","mainFile":"main.tex","engine":"auto","workDir":".","outputDir":"."},
                {"id":"b","name":"b","mainFile":"en/main.tex","engine":"auto","workDir":"en","outputDir":"output/en"}]}"#,
            ),
            (".writerignore", "notes/\n"),
            (".git/config", "x"),
            ("node_modules/x/index.js", "x"),
        ] {
            let file = root.join(path);
            tokio::fs::create_dir_all(file.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(file, text).await.unwrap();
        }
        assert_eq!(list(&root).await.unwrap(), ["figures/plot.pdf", "main.tex"]);
    }

    #[tokio::test]
    async fn writes_only_over_the_expected_content_and_stays_inside_the_project() {
        let d = tempfile::tempdir().unwrap();
        let project = d.path().to_string_lossy().into_owned();
        let encode = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        assert!(
            sync_write(project.clone(), "a/b.tex".into(), encode("one"), None)
                .await
                .unwrap()
        );
        // Created meanwhile: a write that expected no file must not replace it.
        assert!(
            !sync_write(project.clone(), "a/b.tex".into(), encode("two"), None)
                .await
                .unwrap()
        );
        assert!(sync_write(
            project.clone(),
            "a/b.tex".into(),
            encode("two"),
            Some(hex(b"one"))
        )
        .await
        .unwrap());
        assert!(sync_move(project.clone(), "a/b.tex".into(), "c.tex".into())
            .await
            .unwrap());
        assert!(!sync_remove(project.clone(), "c.tex".into(), hex(b"one"))
            .await
            .unwrap());
        assert!(sync_remove(project.clone(), "c.tex".into(), hex(b"two"))
            .await
            .unwrap());
        assert!(!d.path().join("a").exists(), "emptied directory removed");
        for bad in ["../x.tex", "/etc/passwd", ".git/config", "a/../../x"] {
            assert!(sync_write(project.clone(), bad.into(), encode("x"), None)
                .await
                .is_err());
        }
    }
}
