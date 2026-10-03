//! Durable, per-task review of edits already written by native agent harnesses.
use super::{document_merge, git_snapshots, saving, writing};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::{fs, sync::Mutex};
static ACTIVE: OnceLock<Mutex<HashMap<String, (String, String, bool)>>> = OnceLock::new();
fn active() -> &'static Mutex<HashMap<String, (String, String, bool)>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
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
async fn path(project: &str, id: &str) -> Result<std::path::PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "无效审阅 ID")?;
    Ok(writing::metadata(project, "reviews")
        .await?
        .join(format!("{id}.json")))
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
    let summary_path = writing::metadata(project, "review-index")
        .await?
        .join(format!("{}.json", r.id));
    saving::atomic_write(
        &summary_path,
        &serde_json::to_vec(&summary).map_err(|e| e.to_string())?,
    )
    .await
}
pub async fn begin(project: &str, actor: &str) -> Result<String, String> {
    let mut running = active().lock().await;
    if let Some((old, id, _)) = running.get(actor).cloned() {
        if old != project {
            return Err("该会话属于其他项目".into());
        }
        // A new turn may be delivered by the UI before the old idle event reaches
        // the native monitor. Close its record here; steer never calls begin.
        finish_record(&old, &id).await?;
        running.remove(actor);
    }
    let baseline = writing::sources(project).await?;
    let version = git_snapshots::create_snapshot(project, Some("Writer · AI 修改前"), &[])
        .await?
        .hash;
    let annotations = super::annotations::load(project)
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
        baseline,
        changes: vec![],
        decisions: vec![],
        version,
        annotations,
    };
    store(project, &review).await?;
    running.insert(actor.into(), (project.into(), review.id.clone(), false));
    Ok(review.id)
}
pub async fn mark_running(actor: &str) {
    if let Some(entry) = active().lock().await.get_mut(actor) {
        entry.2 = true;
    }
}
pub async fn finish_if_started(app: &AppHandle, actor: &str) -> Result<(), String> {
    let started = active()
        .lock()
        .await
        .get(actor)
        .is_some_and(|entry| entry.2);
    if started {
        finish(app, actor).await
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn review_end(app: AppHandle, actor: String) -> Result<(), String> {
    finish(&app, &actor).await
}
pub async fn finish(app: &AppHandle, actor: &str) -> Result<(), String> {
    let mut running = active().lock().await;
    let Some((project, id, _)) = running.get(actor).cloned() else {
        return Ok(());
    };
    let result = finish_record(&project, &id).await;
    if result.is_ok() {
        running.remove(actor);
    }
    let _ = app.emit(
        "writer://reviews-changed",
        serde_json::json!({"project":project,"error":result.as_ref().err()}),
    );
    result
}
async fn finish_record(project: &str, id: &str) -> Result<(), String> {
    let mut r = load(project, id).await?;
    if r.finished_at.is_some() {
        return Ok(());
    }
    let after = writing::sources(project).await?;
    let mut paths: Vec<_> = r
        .baseline
        .iter()
        .chain(&after)
        .map(|f| f.path.clone())
        .collect();
    paths.sort();
    paths.dedup();
    r.changes = paths
        .iter()
        .filter_map(|path| {
            let before = r
                .baseline
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
    git_snapshots::create_snapshot(project, Some("Writer · AI 修改后待审阅"), &[]).await?;
    Ok(())
}
async fn load(project: &str, id: &str) -> Result<Review, String> {
    let p = path(project, id).await?;
    let meta = fs::symlink_metadata(&p).await.map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || meta.len() > 70_000_000 {
        return Err("审阅文件无效或过大".into());
    }
    serde_json::from_slice(&fs::read(p).await.map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn review_begin(project: String, actor: String) -> Result<String, String> {
    begin(&project, &actor).await
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
    active().lock().await.remove(&record.actor);
    finish_record(&project, &id).await?;
    let _ = app.emit(
        "writer://reviews-changed",
        serde_json::json!({"project":project}),
    );
    Ok(())
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
    let _ = app.emit(
        "writer://reviews-changed",
        serde_json::json!({"project":project}),
    );
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
        active().lock().await.remove(&actor);
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
        active().lock().await.remove(&actor);
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
