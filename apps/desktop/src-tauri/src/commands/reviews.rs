//! Durable, per-task review of edits already written by native agent harnesses.
//!
//! Capture is best effort: a review that cannot be recorded is reported to the UI and
//! never stops the agent turn itself.
use super::{document_merge, git_snapshots, saving, writing};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter};
use tokio::{fs, sync::Mutex};
/// Running reviews by actor: (canonical project, review id, agent turn started).
static ACTIVE: Mutex<BTreeMap<String, (String, String, bool)>> = Mutex::const_new(BTreeMap::new());
/// Serialises every read-modify-write of review records and baselines. Never acquired while
/// holding `ACTIVE` or `saving::SAVE_LOCK`.
static REVIEW_LOCK: Mutex<()> = Mutex::const_new(());
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: usize,
    pub before: String,
    pub after: String,
    pub changed: bool,
    pub status: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub before: String,
    pub after: String,
    pub parts: Vec<Part>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub path: String,
    pub part: usize,
    pub from: String,
    pub to: String,
    pub at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub actor: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub revision: u64,
    /// Only records written by older versions keep the baseline inline. New baselines live
    /// in an untracked file so Git versions do not copy the whole project for every turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub baseline: Vec<writing::SourceFile>,
    pub changes: Vec<Change>,
    pub decisions: Vec<Decision>,
    pub version: String,
    pub annotations: Vec<String>,
}
fn parts(before: &str, after: &str) -> Vec<Part> {
    let diff = similar::TextDiff::from_lines(before, after);
    let mut out: Vec<Part> = vec![];
    for change in diff.iter_all_changes() {
        let tag = change.tag();
        let changed = tag != similar::ChangeTag::Equal;
        if out.last().is_none_or(|p| p.changed != changed) {
            out.push(Part {
                id: out.len(),
                before: String::new(),
                after: String::new(),
                changed,
                status: if changed { "pending" } else { "unchanged" }.into(),
            });
        }
        let p = out.last_mut().unwrap();
        if tag != similar::ChangeTag::Insert {
            p.before.push_str(change.value());
        }
        if tag != similar::ChangeTag::Delete {
            p.after.push_str(change.value());
        }
    }
    out
}
fn render(change: &Change) -> String {
    change
        .parts
        .iter()
        .map(|p| {
            if p.status == "rejected" {
                p.before.as_str()
            } else {
                p.after.as_str()
            }
        })
        .collect()
}
async fn canonical(project: &str) -> Result<String, String> {
    Ok(super::annotations::root(project)
        .await?
        .to_string_lossy()
        .into_owned())
}
async fn record_file(project: &str, kind: &str, id: &str) -> Result<std::path::PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效审阅 ID")?;
    Ok(writing::metadata(project, kind)
        .await?
        .join(format!("{id}.json")))
}
async fn path(project: &str, id: &str) -> Result<std::path::PathBuf, String> {
    record_file(project, "reviews", id).await
}
async fn read_bounded(p: &std::path::Path) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(p).await.map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || meta.len() > 70_000_000 {
        return Err("审阅文件无效或过大".into());
    }
    fs::read(p).await.map_err(|e| e.to_string())
}
async fn store(project: &str, r: &Review) -> Result<(), String> {
    saving::atomic_write(
        &path(project, &r.id).await?,
        &serde_json::to_vec(r).map_err(|e| e.to_string())?,
    )
    .await?;
    let pending = r
        .changes
        .iter()
        .flat_map(|c| &c.parts)
        .filter(|p| p.status == "pending")
        .count();
    let summary = serde_json::json!({"id":r.id,"actor":r.actor,"startedAt":r.started_at,"finishedAt":r.finished_at,"pending":pending,"files":r.changes.len(),"revision":r.revision});
    saving::atomic_write(
        &record_file(project, "review-index", &r.id).await?,
        &serde_json::to_vec(&summary).map_err(|e| e.to_string())?,
    )
    .await
}
async fn store_baseline(
    project: &str,
    id: &str,
    files: &[writing::SourceFile],
) -> Result<(), String> {
    saving::atomic_write(
        &record_file(project, "review-baselines", id).await?,
        &serde_json::to_vec(files).map_err(|e| e.to_string())?,
    )
    .await
}
async fn load_baseline(project: &str, r: &Review) -> Result<Vec<writing::SourceFile>, String> {
    if !r.baseline.is_empty() {
        return Ok(r.baseline.clone());
    }
    let file = record_file(project, "review-baselines", &r.id).await?;
    serde_json::from_slice(&read_bounded(&file).await?).map_err(|e| e.to_string())
}
fn emit_changed(app: &AppHandle, project: &str, error: Option<&String>) {
    let _ = app.emit(
        "writer://reviews-changed",
        serde_json::json!({"project":project,"error":error}),
    );
}
/// Record the pre-turn baseline. Agent turns call `begin_or_report` instead, so a project
/// that cannot be captured (no Git, unreadable files) still lets the agent run.
pub async fn begin(project: &str, actor: &str) -> Result<String, String> {
    let project = canonical(project).await?;
    let previous = {
        let mut running = ACTIVE.lock().await;
        if running
            .get(actor)
            .is_some_and(|(old, _, _)| *old != project)
        {
            return Err("该会话属于其他项目".into());
        }
        running.remove(actor)
    };
    let _guard = REVIEW_LOCK.lock().await;
    // A new turn may be delivered by the UI before the old idle event reaches the native
    // monitor. Close its record here; steer never calls begin.
    if let Some((old, id, _)) = previous {
        finish_record(&old, &id).await?;
    }
    let baseline = writing::sources(&project).await?;
    let version = git_snapshots::create_snapshot(&project, Some("Writer · AI 修改前"), &[])
        .await?
        .hash;
    let annotations = super::annotations::load(&project)
        .await?
        .iter()
        .filter(|a| !a.resolved)
        .map(|a| a.id.clone())
        .collect();
    let review = Review {
        id: uuid::Uuid::new_v4().to_string(),
        actor: actor.into(),
        started_at: now(),
        finished_at: None,
        revision: 0,
        baseline: vec![],
        changes: vec![],
        decisions: vec![],
        version,
        annotations,
    };
    store_baseline(&project, &review.id, &baseline).await?;
    store(&project, &review).await?;
    ACTIVE
        .lock()
        .await
        .insert(actor.into(), (project, review.id.clone(), false));
    Ok(review.id)
}
pub async fn begin_or_report(app: &AppHandle, project: &str, actor: &str) {
    if let Err(error) = begin(project, actor).await {
        let message = format!("本轮 AI 修改未能记录审阅（不影响任务执行）：{error}");
        emit_changed(app, project, Some(&message));
    }
}
/// Closes the review of a turn that never started (any early return before the agent runs).
pub struct TurnGuard {
    app: AppHandle,
    actor: Option<String>,
}
impl TurnGuard {
    pub fn new(app: &AppHandle, actor: &str) -> Self {
        Self {
            app: app.clone(),
            actor: Some(actor.into()),
        }
    }
    pub fn disarm(mut self) {
        self.actor = None;
    }
}
impl Drop for TurnGuard {
    fn drop(&mut self) {
        if let Some(actor) = self.actor.take() {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = finish(&app, &actor).await;
            });
        }
    }
}
pub async fn mark_running(actor: &str) {
    if let Some(entry) = ACTIVE.lock().await.get_mut(actor) {
        entry.2 = true;
    }
}
/// Called from agent event loops: claim the record now, build the review in the background
/// so a large project never stalls the harness connection.
pub async fn finish_if_started(app: &AppHandle, actor: &str) {
    let claimed = {
        let mut running = ACTIVE.lock().await;
        if running.get(actor).is_some_and(|entry| entry.2) {
            running.remove(actor)
        } else {
            None
        }
    };
    if let Some((project, id, _)) = claimed {
        let app = app.clone();
        tokio::spawn(async move {
            let result = {
                let _guard = REVIEW_LOCK.lock().await;
                finish_record(&project, &id).await
            };
            emit_changed(&app, &project, result.as_ref().err());
        });
    }
}
pub async fn finish(app: &AppHandle, actor: &str) -> Result<(), String> {
    let Some((project, id, _)) = ACTIVE.lock().await.remove(actor) else {
        return Ok(());
    };
    let result = {
        let _guard = REVIEW_LOCK.lock().await;
        finish_record(&project, &id).await
    };
    emit_changed(app, &project, result.as_ref().err());
    result
}
async fn finish_record(project: &str, id: &str) -> Result<(), String> {
    let mut r = load(project, id).await?;
    if r.finished_at.is_some() {
        return Ok(());
    }
    let baseline = load_baseline(project, &r).await?;
    let after = writing::sources(project).await?;
    let mut paths: Vec<_> = baseline
        .iter()
        .chain(&after)
        .map(|f| f.path.clone())
        .collect();
    paths.sort();
    paths.dedup();
    r.changes = paths
        .iter()
        .filter_map(|path| {
            let before = baseline
                .iter()
                .find(|f| f.path == *path)
                .map(|f| f.content.as_str())
                .unwrap_or("");
            let after = after
                .iter()
                .find(|f| f.path == *path)
                .map(|f| f.content.as_str())
                .unwrap_or("");
            (before != after).then(|| Change {
                path: path.clone(),
                before: before.into(),
                after: after.into(),
                parts: parts(before, after),
            })
        })
        .collect();
    r.finished_at = Some(now());
    r.revision += 1;
    r.baseline.clear();
    store(project, &r).await?;
    if let Ok(file) = record_file(project, "review-baselines", id).await {
        let _ = fs::remove_file(file).await;
    }
    git_snapshots::create_snapshot(project, Some("Writer · AI 修改后待审阅"), &[]).await?;
    Ok(())
}
/// A person's save during an agent turn is not an agent edit. Apply the saved delta
/// (`before` -> `after`, `before == None` for a new file) to every running baseline, so the
/// review shows only what the agent changed. Overlapping edits keep the old baseline.
pub async fn rebase_human_edit(
    project: &str,
    path: &str,
    before: Option<&str>,
    after: &str,
) -> Result<(), String> {
    let project = canonical(project).await?;
    let _guard = REVIEW_LOCK.lock().await;
    let ids: Vec<String> = ACTIVE
        .lock()
        .await
        .values()
        .filter(|(p, _, _)| *p == project)
        .map(|(_, id, _)| id.clone())
        .collect();
    for id in ids {
        let r = load(&project, &id).await?;
        if r.finished_at.is_some() {
            continue;
        }
        let mut files = load_baseline(&project, &r).await?;
        let changed = match (files.iter_mut().find(|f| f.path == path), before) {
            (Some(file), Some(before)) => {
                match document_merge::merge(before, &file.content, after).content {
                    Some(merged) if merged != file.content => {
                        file.revision = writing::hash(&merged);
                        file.content = merged;
                        true
                    }
                    _ => false,
                }
            }
            (None, None) => {
                files.push(writing::SourceFile {
                    path: path.into(),
                    revision: writing::hash(after),
                    content: after.into(),
                });
                files.sort_by(|a, b| a.path.cmp(&b.path));
                true
            }
            _ => false,
        };
        if changed {
            store_baseline(&project, &id, &files).await?;
        }
    }
    Ok(())
}
async fn load(project: &str, id: &str) -> Result<Review, String> {
    serde_json::from_slice(&read_bounded(&path(project, id).await?).await?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn review_begin(app: AppHandle, project: String, actor: String) -> Result<(), String> {
    begin_or_report(&app, &project, &actor).await;
    Ok(())
}
#[tauri::command]
pub async fn review_read(project: String, id: String) -> Result<Review, String> {
    load(&project, &id).await
}
#[tauri::command]
pub async fn review_list(project: String) -> Result<Vec<serde_json::Value>, String> {
    let mut entries = fs::read_dir(writing::metadata(&project, "review-index").await?)
        .await
        .map_err(|e| e.to_string())?;
    let mut all = vec![];
    while let Some(e) = entries.next_entry().await.map_err(|e| e.to_string())? {
        if !e.file_type().await.map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let bytes = fs::read(e.path()).await.map_err(|e| e.to_string())?;
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            all.push(v);
        }
    }
    all.sort_by_key(|v| std::cmp::Reverse(v["startedAt"].as_u64().unwrap_or(0)));
    all.truncate(100);
    Ok(all)
}
#[tauri::command]
pub async fn review_finalize(app: AppHandle, project: String, id: String) -> Result<(), String> {
    let record = load(&project, &id).await?;
    if super::writer_bridge::conversation_is_busy(&app, &record.actor).await {
        return Err("任务仍在运行，请结束后审阅".into());
    }
    {
        let mut running = ACTIVE.lock().await;
        if running
            .get(&record.actor)
            .is_some_and(|entry| entry.1 == id)
        {
            running.remove(&record.actor);
        }
    }
    let result = {
        let _guard = REVIEW_LOCK.lock().await;
        finish_record(&project, &id).await
    };
    emit_changed(&app, &project, None);
    result
}
#[tauri::command]
pub async fn review_decide(
    app: AppHandle,
    project: String,
    id: String,
    expected_revision: u64,
    file: String,
    part: usize,
    status: String,
) -> Result<Review, String> {
    let result = decide_record(project.clone(), id, expected_revision, file, part, status).await?;
    emit_changed(&app, &project, None);
    Ok(result)
}
async fn decide_record(
    project: String,
    id: String,
    expected_revision: u64,
    file: String,
    part: usize,
    status: String,
) -> Result<Review, String> {
    if !["pending", "accepted", "rejected"].contains(&status.as_str()) {
        return Err("无效审阅状态".into());
    }
    let _guard = REVIEW_LOCK.lock().await;
    let mut r = load(&project, &id).await?;
    if r.finished_at.is_none() || r.revision != expected_revision {
        return Err("审阅版本已变化，请刷新".into());
    }
    let change = r
        .changes
        .iter_mut()
        .find(|c| c.path == file)
        .ok_or("文件不在修改集里")?;
    let base = render(change);
    let p = change
        .parts
        .get_mut(part)
        .filter(|p| p.changed)
        .ok_or("修改项不存在")?;
    let from = p.status.clone();
    if from == status {
        return Ok(r);
    };
    p.status = status.clone();
    let proposed = render(change);
    let (_, target) = saving::target_path(&project, &file).await?;
    if fs::try_exists(&target).await.map_err(|e| e.to_string())? {
        let result = document_merge::save(
            &project,
            &file,
            &base,
            &proposed,
            &format!("review:{id}"),
            None,
        )
        .await?;
        if result.status == "conflict" {
            return Err("此处已有后续修改，双方内容已保留，请到冲突面板合并后再审阅。".into());
        }
    } else if !proposed.is_empty() {
        writing::apply(
            &project,
            vec![writing::FileEdit {
                path: file.clone(),
                expected: None,
                content: proposed,
            }],
            "恢复审阅文件",
        )
        .await?;
    }
    r.decisions.push(Decision {
        id: uuid::Uuid::new_v4().to_string(),
        path: file,
        part,
        from,
        to: status,
        at: now(),
    });
    r.revision += 1;
    store(&project, &r).await?;
    git_snapshots::create_snapshot(&project, Some("Writer · 文稿审阅决定"), &[]).await?;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queued_turn_closes_previous_record_before_capturing_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("main.tex");
        fs::write(&file, "initial").await.unwrap();
        let actor = format!("opencode:{}", uuid::Uuid::new_v4());
        let first = begin(&project, &actor).await.unwrap();
        fs::write(&file, "first turn").await.unwrap();
        let second = begin(&project, &actor).await.unwrap();
        assert_ne!(first, second);
        let first = load(&project, &first).await.unwrap();
        assert!(first.finished_at.is_some());
        assert_eq!(first.changes[0].after, "first turn");
        fs::write(&file, "second turn").await.unwrap();
        finish_record(&project, &second).await.unwrap();
        let second = load(&project, &second).await.unwrap();
        assert_eq!(second.changes[0].before, "first turn");
        assert_eq!(second.changes[0].after, "second turn");
        ACTIVE.lock().await.remove(&actor);
    }
    #[tokio::test]
    async fn human_saves_during_a_turn_stay_out_of_the_agent_review() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("main.tex");
        fs::write(&file, "intro\nmethod\nresult\n").await.unwrap();
        let actor = format!("codex:{}", uuid::Uuid::new_v4());
        let id = begin(&project, &actor).await.unwrap();
        // The agent edits one line on disk while the person's editor still holds the old text.
        fs::write(&file, "intro\nmethod (agent)\nresult\n")
            .await
            .unwrap();
        let saved = document_merge::save(
            &project,
            "main.tex",
            "intro\nmethod\nresult\n",
            "intro by me\nmethod\nresult\n",
            "editor",
            None,
        )
        .await
        .unwrap();
        assert_eq!(saved.content, "intro by me\nmethod (agent)\nresult\n");
        rebase_human_edit(
            &project,
            "main.tex",
            saved.previous.as_deref(),
            &saved.content,
        )
        .await
        .unwrap();
        rebase_human_edit(&project, "notes.md", None, "my notes\n")
            .await
            .unwrap();
        fs::write(dir.path().join("notes.md"), "my notes\n")
            .await
            .unwrap();
        ACTIVE.lock().await.remove(&actor);
        finish_record(&project, &id).await.unwrap();
        let r = load(&project, &id).await.unwrap();
        assert_eq!(r.changes.len(), 1, "only main.tex changed by the agent");
        let changed: Vec<_> = r.changes[0].parts.iter().filter(|p| p.changed).collect();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].before, "method\n");
        assert_eq!(changed[0].after, "method (agent)\n");
        assert!(r.baseline.is_empty());
        assert!(!dir
            .path()
            .join(".writer/review-baselines")
            .join(format!("{id}.json"))
            .exists());
    }
    #[tokio::test]
    async fn capture_tolerates_alias_paths_and_unreadable_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("main.tex"), "text")
            .await
            .unwrap();
        fs::write(dir.path().join("latin1.tex"), [0xff_u8, 0xfe, 0x41])
            .await
            .unwrap();
        fs::write(dir.path().join("data.txt"), "x".repeat(2_100_000))
            .await
            .unwrap();
        #[cfg(unix)]
        let alias = {
            let alias = dir.path().join("alias");
            std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
            alias
        };
        #[cfg(not(unix))]
        let alias = dir.path().to_path_buf();
        let actor = format!("claude:{}", uuid::Uuid::new_v4());
        begin(&alias.to_string_lossy(), &actor).await.unwrap();
        let canonical = fs::canonicalize(dir.path()).await.unwrap();
        let second = begin(&canonical.to_string_lossy(), &actor).await.unwrap();
        let baseline = load_baseline(
            &canonical.to_string_lossy(),
            &load(&canonical.to_string_lossy(), &second).await.unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            baseline.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["main.tex"]
        );
        ACTIVE.lock().await.remove(&actor);
    }
    #[tokio::test]
    async fn reject_and_undo_preserve_later_edits_and_refuse_overlap() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("main.tex");
        fs::write(&file, "alpha\nbeta\n").await.unwrap();
        let actor = format!("codex:{}", uuid::Uuid::new_v4());
        let id = begin(&project, &actor).await.unwrap();
        fs::write(&file, "ALPHA\nbeta\n").await.unwrap();
        finish_record(&project, &id).await.unwrap();
        ACTIVE.lock().await.remove(&actor);
        let r = load(&project, &id).await.unwrap();
        let index = r.changes[0].parts.iter().position(|p| p.changed).unwrap();
        fs::write(&file, "ALPHA\nbeta\nmanual addition\n")
            .await
            .unwrap();
        let r = decide_record(
            project.clone(),
            id.clone(),
            r.revision,
            "main.tex".into(),
            index,
            "rejected".into(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(&file).await.unwrap(),
            "alpha\nbeta\nmanual addition\n"
        );
        let r = decide_record(
            project.clone(),
            id.clone(),
            r.revision,
            "main.tex".into(),
            index,
            "pending".into(),
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(&file).await.unwrap(),
            "ALPHA\nbeta\nmanual addition\n"
        );
        fs::write(&file, "human rewrite\nbeta\nmanual addition\n")
            .await
            .unwrap();
        assert!(decide_record(
            project,
            id,
            r.revision,
            "main.tex".into(),
            index,
            "rejected".into()
        )
        .await
        .is_err());
        assert!(fs::read_to_string(&file)
            .await
            .unwrap()
            .starts_with("human rewrite"));
    }
}
