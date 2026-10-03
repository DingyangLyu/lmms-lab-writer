//! Local paper versions. A private ref and temporary index never move HEAD or
//! disturb a user's partially staged changes. No hooks or network operations.
use super::util::command;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use tokio::sync::Mutex;
const SNAPSHOT_REF: &str = "refs/writer/snapshots";
static SNAPSHOT_LOCK: Mutex<()> = Mutex::const_new(());
const EXCLUDED: &[&str] = &[
    ".lmms_lab_writer",
    ".DS_Store",
    ".env",
    ".env.local",
    ".opencode",
    "node_modules",
    "target",
    "tmp",
    ".writer",
];

/// Versions of a project nested inside another repository stay out of that repository.
fn private_dir(project: &str) -> PathBuf {
    Path::new(project).join(".writer").join("versions.git")
}
async fn git_command(project: &str) -> tokio::process::Command {
    let mut cmd = command("git");
    cmd.current_dir(project)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    let private = private_dir(project);
    if tokio::fs::try_exists(private.join("HEAD"))
        .await
        .unwrap_or(false)
    {
        cmd.args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .env("GIT_DIR", &private)
        .env("GIT_WORK_TREE", project);
    }
    cmd
}
async fn git(project: &str, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    let mut cmd = git_command(project).await;
    cmd.args(args);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    // Only this process uses a fallback identity; never alter the user's config.
    cmd.env("GIT_AUTHOR_NAME", "LMMs-Lab Writer")
        .env("GIT_AUTHOR_EMAIL", "writer@localhost")
        .env("GIT_COMMITTER_NAME", "LMMs-Lab Writer")
        .env("GIT_COMMITTER_EMAIL", "writer@localhost");
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    String::from_utf8(output.stdout).map_err(|_| "此版本含二进制内容，无法作为文本读取".into())
}
async fn repo_root(project: &str, initialize: bool) -> Result<bool, String> {
    let canonical = tokio::fs::canonicalize(project)
        .await
        .map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("项目目录不存在".into());
    }
    match git(project, &["rev-parse", "--show-toplevel"], None).await {
        Ok(root) => {
            let root = tokio::fs::canonicalize(root.trim())
                .await
                .map_err(|e| e.to_string())?;
            if root == canonical {
                Ok(true)
            } else if initialize {
                // A paper folder inside a larger repository (repo/paper/) keeps its
                // versions in a private repository; the enclosing one is untouched.
                init_private(project).await?;
                Ok(true)
            } else {
                Ok(false)
            }
        }
        Err(_) if initialize => {
            git(project, &["init", "."], None).await?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}
async fn init_private(project: &str) -> Result<(), String> {
    let writer = Path::new(project).join(".writer");
    match tokio::fs::create_dir(&writer).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    let meta = tokio::fs::symlink_metadata(&writer)
        .await
        .map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(".writer 不能是链接或普通文件".into());
    }
    let dir = private_dir(project);
    let output = command("git")
        .current_dir(project)
        .args(["init", "--quiet"])
        .env("GIT_DIR", &dir)
        .env("GIT_WORK_TREE", project)
        .env_remove("GIT_INDEX_FILE")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    tokio::fs::create_dir_all(dir.join("info"))
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        dir.join("info").join("exclude"),
        ".writer/\n.lmms_lab_writer/\n",
    )
    .await
    .map_err(|e| e.to_string())
}
async fn ref_hash(project: &str, name: &str) -> Option<String> {
    git(project, &["rev-parse", "--verify", name], None)
        .await
        .ok()
        .map(|s| s.trim().to_string())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    pub is_repo: bool,
    pub head: Option<String>,
    pub snapshot: Option<String>,
}
#[tauri::command]
pub async fn git_snapshot_status(project: String) -> Result<SnapshotStatus, String> {
    let is_repo = repo_root(&project, false).await?;
    let (head, snapshot) = if is_repo {
        tokio::join!(ref_hash(&project, "HEAD"), ref_hash(&project, SNAPSHOT_REF))
    } else {
        (None, None)
    };
    Ok(SnapshotStatus {
        is_repo,
        head,
        snapshot,
    })
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResult {
    pub created: bool,
    pub hash: String,
}

#[tauri::command]
pub async fn git_create_snapshot(
    project: String,
    message: Option<String>,
) -> Result<SnapshotResult, String> {
    let label = message.filter(|m| !m.trim().is_empty() && m.len() <= 200);
    create_snapshot(&project, label.as_deref(), &[]).await
}
/// Explicit annotation versions share the same private ref and leave HEAD/index intact.
pub async fn create_snapshot(
    project: &str,
    label: Option<&str>,
    events: &[String],
) -> Result<SnapshotResult, String> {
    let _guard = SNAPSHOT_LOCK.lock().await;
    repo_root(&project, true).await?;
    // Also keeps Writer data out of an enclosing repository's status and `git add -A`.
    let _ = super::git::protect_private_dirs(project).await;
    let git_dir = git(&project, &["rev-parse", "--absolute-git-dir"], None).await?;
    let index =
        PathBuf::from(git_dir.trim()).join(format!("writer-index-{}", uuid::Uuid::new_v4()));
    let result = snapshot_with_index(project, &index, label, events).await;
    let _ = tokio::fs::remove_file(&index).await;
    let _ = tokio::fs::remove_file(index.with_extension("lock")).await;
    result
}
async fn snapshot_with_index(
    project: &str,
    index: &Path,
    label: Option<&str>,
    events: &[String],
) -> Result<SnapshotResult, String> {
    let head = ref_hash(project, "HEAD").await;
    let previous = ref_hash(project, SNAPSHOT_REF).await;
    if let Some(head) = &head {
        git(project, &["read-tree", head], Some(index)).await?;
    } else {
        git(project, &["read-tree", "--empty"], Some(index)).await?;
    }
    let mut rm_args = vec!["rm", "--cached", "-r", "--ignore-unmatch", "--"];
    rm_args.extend_from_slice(EXCLUDED);
    git(project, &rm_args, Some(index)).await?;
    // Enumerate literal paths first: git add's exclusion pathspecs can still error on
    // ignored parent directories. This also avoids ever staging private/cache files.
    let listed = git(
        project,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        Some(index),
    )
    .await?;
    let paths: std::collections::BTreeSet<&str> = listed
        .split('\0')
        .filter(|path| {
            !path.is_empty()
                && !EXCLUDED
                    .iter()
                    .any(|prefix| *path == *prefix || path.starts_with(&format!("{prefix}/")))
                && path.rsplit('/').next() != Some(".DS_Store")
        })
        .collect();
    let paths: Vec<_> = paths.into_iter().collect();
    for batch in paths.chunks(128) {
        let mut args = vec!["--literal-pathspecs", "add", "-A", "--"];
        args.extend_from_slice(batch);
        git(project, &args, Some(index)).await?;
    }
    // Keep portable project metadata even when dot-directories are ignored by ordinary Git.
    for metadata in [
        ".writer/pdf-annotations.json",
        ".writer/latex.json",
        ".writer/revisions",
        ".writer/conflicts",
        ".writer/reviews",
        ".writer/review-index",
    ] {
        if Path::new(project).join(metadata).exists() {
            git(project, &["add", "-f", "--", metadata], Some(index)).await?;
        }
    }
    let tree = git(project, &["write-tree"], Some(index))
        .await?
        .trim()
        .to_string();
    if let Some(previous) = &previous {
        let old_tree = git(
            project,
            &["rev-parse", &format!("{previous}^{{tree}}")],
            None,
        )
        .await?;
        if old_tree.trim() == tree && events.is_empty() {
            return Ok(SnapshotResult {
                created: false,
                hash: previous.clone(),
            });
        }
    }
    let message = format!(
        "{}\n\nSource-HEAD: {}\n{}",
        label.unwrap_or("Writer 论文版本"),
        head.as_deref().unwrap_or("unborn"),
        events
            .iter()
            .map(|id| format!("Writer-Annotation-Event: {id}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let mut args = vec!["commit-tree", &tree, "-m", &message];
    if let Some(parent) = &previous {
        args.extend(["-p", parent]);
    }
    let hash = git(project, &args, None).await?.trim().to_string();
    let zero = "0".repeat(hash.len());
    git(
        project,
        &[
            "update-ref",
            "--create-reflog",
            "-m",
            "Writer saved paper version",
            SNAPSHOT_REF,
            &hash,
            previous.as_deref().unwrap_or(&zero),
        ],
        None,
    )
    .await?;
    Ok(SnapshotResult {
        created: true,
        hash,
    })
}
/// Commit trailers provide durable event -> version links, without self-referential hashes
/// in the tracked annotations JSON or a second uncommitted metadata write.
pub async fn annotation_versions(project: &str) -> Result<HashMap<String, String>, String> {
    if !repo_root(project, false).await? || ref_hash(project, SNAPSHOT_REF).await.is_none() {
        return Ok(HashMap::new());
    }
    let log = git(
        project,
        &[
            "log",
            "--format=%H%x00%B%x00",
            "--grep=Writer-Annotation-Event:",
            SNAPSHOT_REF,
        ],
        None,
    )
    .await?;
    let chunks: Vec<_> = log.split('\0').collect();
    let mut versions = HashMap::new();
    for pair in chunks.chunks(2) {
        if let [hash, body] = pair {
            for line in body.lines() {
                if let Some(id) = line.strip_prefix("Writer-Annotation-Event: ") {
                    versions
                        .entry(id.trim().to_string())
                        .or_insert_with(|| hash.trim().to_string());
                }
            }
        }
    }
    Ok(versions)
}
#[derive(Debug, Serialize)]
pub struct SnapshotEntry {
    pub hash: String,
    pub timestamp: i64,
    pub message: String,
}
#[tauri::command]
pub async fn git_snapshot_history(project: String) -> Result<Vec<SnapshotEntry>, String> {
    if !repo_root(&project, false).await? || ref_hash(&project, SNAPSHOT_REF).await.is_none() {
        return Ok(vec![]);
    }
    let log = git(
        &project,
        &["log", "-100", "--format=%H%x09%ct%x09%s", SNAPSHOT_REF],
        None,
    )
    .await?;
    Ok(log
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            Some(SnapshotEntry {
                hash: parts.next()?.into(),
                timestamp: parts.next()?.parse::<i64>().ok()? * 1000,
                message: parts.next()?.into(),
            })
        })
        .collect())
}
async fn validate_snapshot(project: &str, hash: &str) -> Result<(), String> {
    repo_root(project, false).await?;
    if ![40, 64].contains(&hash.len()) || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效版本号".into());
    }
    git(
        project,
        &["merge-base", "--is-ancestor", hash, SNAPSHOT_REF],
        None,
    )
    .await
    .map(|_| ())
}
#[tauri::command]
pub async fn git_snapshot_diff(project: String, hash: String) -> Result<String, String> {
    validate_snapshot(&project, &hash).await?;
    let diff = git(
        &project,
        &[
            "show",
            "--format=short",
            "--stat",
            "--patch",
            "--no-ext-diff",
            "--no-textconv",
            &hash,
            "--",
        ],
        None,
    )
    .await?;
    if diff.chars().count() > 150_000 {
        Ok(format!(
            "{}\n…差异过长，已截断预览。",
            diff.chars().take(150_000).collect::<String>()
        ))
    } else {
        Ok(diff)
    }
}
#[tauri::command]
pub async fn git_snapshot_file(
    project: String,
    hash: String,
    path: String,
) -> Result<String, String> {
    validate_snapshot(&project, &hash).await?;
    if path.is_empty()
        || Path::new(&path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("无效项目文件路径".into());
    }
    git(&project, &["show", &format!("{hash}:{path}")], None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> String {
        let path = std::env::temp_dir().join(format!("writer-git-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&path).await.unwrap();
        path.to_str().unwrap().into()
    }
    #[tokio::test]
    async fn snapshots_preserve_head_staging_and_restore_contents() {
        let project = fixture().await;
        repo_root(&project, true).await.unwrap();
        tokio::fs::write(format!("{project}/main.tex"), "original")
            .await
            .unwrap();
        git(&project, &["add", "."], None).await.unwrap();
        git(&project, &["commit", "-m", "Initial"], None)
            .await
            .unwrap();
        let head = ref_hash(&project, "HEAD").await;
        tokio::fs::write(format!("{project}/main.tex"), "staged")
            .await
            .unwrap();
        git(&project, &["add", "."], None).await.unwrap();
        tokio::fs::write(format!("{project}/main.tex"), "latest working content 中文")
            .await
            .unwrap();
        tokio::fs::write(format!("{project}/.DS_Store"), "noise")
            .await
            .unwrap();
        tokio::fs::create_dir(format!("{project}/.lmms_lab_writer"))
            .await
            .unwrap();
        tokio::fs::write(format!("{project}/.lmms_lab_writer/backup"), "noise")
            .await
            .unwrap();
        let saved = git_create_snapshot(project.clone(), None).await.unwrap();
        assert!(saved.created);
        assert_eq!(ref_hash(&project, "HEAD").await, head);
        assert_eq!(
            git(&project, &["show", ":main.tex"], None).await.unwrap(),
            "staged"
        );
        assert_eq!(
            git_snapshot_file(project.clone(), saved.hash.clone(), "main.tex".into())
                .await
                .unwrap(),
            "latest working content 中文"
        );
        let files = git(
            &project,
            &["ls-tree", "-r", "--name-only", &saved.hash],
            None,
        )
        .await
        .unwrap();
        assert_eq!(files.trim(), "main.tex");
        assert!(
            !git_create_snapshot(project.clone(), None)
                .await
                .unwrap()
                .created
        );
        tokio::fs::remove_file(format!("{project}/main.tex"))
            .await
            .unwrap();
        assert!(
            git_create_snapshot(project.clone(), None)
                .await
                .unwrap()
                .created
        );
        assert_eq!(
            git_snapshot_history(project.clone()).await.unwrap().len(),
            2
        );
        assert!(
            git_snapshot_file(project.clone(), saved.hash, "../secret".into())
                .await
                .is_err()
        );
        tokio::fs::remove_dir_all(project).await.unwrap();
    }
    #[tokio::test]
    async fn initializes_unborn_repo_and_keeps_versions_separate() {
        let project = fixture().await;
        tokio::fs::write(format!("{project}/paper.tex"), "new")
            .await
            .unwrap();
        assert!(!git_snapshot_status(project.clone()).await.unwrap().is_repo);
        let first = git_create_snapshot(project.clone(), None).await.unwrap();
        assert!(first.created);
        assert!(ref_hash(&project, "HEAD").await.is_none());
        assert_eq!(
            git_snapshot_file(project.clone(), first.hash, "paper.tex".into())
                .await
                .unwrap(),
            "new"
        );
        tokio::fs::remove_dir_all(project).await.unwrap();
    }
    #[tokio::test]
    async fn nested_project_uses_a_private_repository() {
        let outer = fixture().await;
        repo_root(&outer, true).await.unwrap();
        let project = format!("{outer}/paper");
        tokio::fs::create_dir(&project).await.unwrap();
        tokio::fs::write(format!("{project}/main.tex"), "nested")
            .await
            .unwrap();
        assert!(!git_snapshot_status(project.clone()).await.unwrap().is_repo);
        let saved = git_create_snapshot(project.clone(), None).await.unwrap();
        assert!(saved.created);
        assert_eq!(
            git_snapshot_file(project.clone(), saved.hash, "main.tex".into())
                .await
                .unwrap(),
            "nested"
        );
        assert!(ref_hash(&outer, SNAPSHOT_REF).await.is_none());
        let status = git(&outer, &["status", "--porcelain", "-uall"], None)
            .await
            .unwrap();
        assert!(!status.contains(".writer"), "{status}");
        tokio::fs::remove_dir_all(outer).await.unwrap();
    }
}

pub async fn git_snapshot_bytes(project: &str, hash: &str, path: &str) -> Result<Vec<u8>, String> {
    validate_snapshot(project, hash).await?;
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("无效项目文件路径".into());
    }
    let output = git_command(project)
        .await
        .args(["show", &format!("{hash}:{path}")])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("该历史版本没有保存原 PDF".into());
    }
    if output.stdout.len() > 256 * 1024 * 1024 {
        return Err("历史 PDF 过大".into());
    }
    Ok(output.stdout)
}
