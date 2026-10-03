use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
pub(crate) static LOCK: Mutex<()> = Mutex::const_new(());
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub page_width: f64,
    pub page_height: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub file: String,
    pub line: u32,
    pub end_line: u32,
    pub context: String,
    pub method: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationEvent {
    pub id: String,
    pub action: String,
    pub timestamp: u64,
    pub comment: String,
    pub resolution: String,
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_hash: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    #[serde(default = "pdf_kind")]
    pub kind: String,
    #[serde(default)]
    pub anchor: Option<TextAnchor>,
    pub id: String,
    pub pdf: String,
    pub quote: String,
    pub comment: String,
    pub style: String,
    pub marks: Vec<Mark>,
    pub fingerprint: String,
    pub created_at: u64,
    pub resolved: bool,
    pub source: Option<Source>,
    pub mapping_note: String,
    #[serde(default)]
    pub resolution: String,
    #[serde(default)]
    pub events: Vec<AnnotationEvent>,
    #[serde(default)]
    pub submitted_to: Option<String>,
}
fn pdf_kind() -> String {
    "pdf".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnchor {
    pub file: String,
    pub revision: String,
    pub ranges: Vec<super::document_merge::AnchorRange>,
}
pub async fn root(project: &str) -> Result<PathBuf, String> {
    let root = tokio::fs::canonicalize(project)
        .await
        .map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("项目目录不存在".into());
    }
    Ok(root)
}
pub async fn project_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("无效的项目内文件路径".into());
    }
    let path = tokio::fs::canonicalize(root.join(relative))
        .await
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("文件超出当前项目".into());
    }
    Ok(path)
}
async fn store_path(project: &str) -> Result<PathBuf, String> {
    let root = root(project).await?;
    let dir = root.join(".writer");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    if !tokio::fs::canonicalize(&dir)
        .await
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("批注目录不在项目中".into());
    }
    let path = dir.join("pdf-annotations.json");
    if path.exists()
        && !tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| e.to_string())?
            .starts_with(&root)
    {
        return Err("批注文件不在项目中".into());
    }
    Ok(path)
}
pub async fn load(project: &str) -> Result<Vec<Annotation>, String> {
    let path = store_path(project).await?;
    match tokio::fs::read(&path).await {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("批注文件损坏，已保留原文件：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}
async fn save(project: &str, items: &[Annotation]) -> Result<(), String> {
    let path = store_path(project).await?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(&temp)
        .await
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&temp, &path)
        .await
        .map_err(|e| e.to_string())
}
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !"{}\\%$~".contains(*c))
        .collect()
}
pub(crate) fn context_at(file: String, text: &str, line: u32, method: &str) -> Source {
    let lines: Vec<_> = text.lines().collect();
    let index = (line.saturating_sub(1) as usize).min(lines.len().saturating_sub(1));
    let mut start = index;
    let mut end = index;
    let boundary = |line: &str| {
        let line = line.trim();
        line.is_empty()
            || [
                "\\section",
                "\\subsection",
                "\\chapter",
                "\\documentclass",
                "\\begin{document}",
                "\\end{document}",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
    };
    while start > 0 && index - start < 15 && !boundary(lines[start - 1]) {
        start -= 1
    }
    while end + 1 < lines.len() && end - index < 15 && !boundary(lines[end + 1]) {
        end += 1
    }
    Source {
        file,
        line: (start + 1) as u32,
        end_line: (end + 1) as u32,
        context: lines.get(start..=end).unwrap_or(&[]).join("\n"),
        method: method.into(),
    }
}
pub async fn locate(
    project: &str,
    pdf: &str,
    mark: &Mark,
    quote: &str,
) -> Result<(Option<Source>, String), String> {
    let root = root(project).await?;
    let pdf = project_file(&root, pdf).await?;
    // synctex edit expects top-left page coordinates, in PDF points.
    let hit = super::latex::latex_synctex_edit(
        pdf.to_string_lossy().into(),
        mark.page,
        (mark.x + mark.width / 2.) * mark.page_width,
        (mark.y + mark.height / 2.) * mark.page_height,
    )
    .await;
    if let Ok(hit) = &hit {
        let path = if Path::new(&hit.file).is_absolute() {
            PathBuf::from(&hit.file)
        } else {
            pdf.parent().unwrap_or(&root).join(&hit.file)
        };
        if let Ok(path) = tokio::fs::canonicalize(path).await {
            if path.starts_with(&root) {
                if let Ok(text) = tokio::fs::read_to_string(&path).await {
                    let file = path
                        .strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    return Ok((
                        Some(context_at(file, &text, hit.line, "synctex")),
                        "SyncTeX 定位；修改前请核对选中文字和当前源码。".into(),
                    ));
                }
            }
        }
    }
    // Conservative unique text fallback; never silently choose an ambiguous paragraph.
    let scan_root = root.clone();
    let files = tokio::task::spawn_blocking(move || {
        walkdir::WalkDir::new(scan_root)
            .max_depth(8)
            .into_iter()
            .filter_entry(|e| {
                !e.file_name().to_string_lossy().starts_with('.') && e.file_name() != "node_modules"
                    || e.depth() == 0
            })
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|v| v == "tex"))
            .map(|e| e.into_path())
            .take(300)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let needle = norm(quote);
    let mut candidates = vec![];
    if needle.chars().count() >= 8 {
        for file in files {
            if let Ok(text) = tokio::fs::read_to_string(&file).await {
                if text.len() > 2_000_000 {
                    continue;
                }
                let normalized = norm(&text);
                if normalized.matches(&needle).count() != 1 {
                    continue;
                }
                let mut paragraph = String::new();
                let mut start = 1;
                for (i, line) in text.lines().chain(std::iter::once("")).enumerate() {
                    if line.trim().is_empty() {
                        if norm(&paragraph).contains(&needle) {
                            candidates.push(context_at(
                                file.strip_prefix(&root)
                                    .unwrap()
                                    .to_string_lossy()
                                    .replace('\\', "/"),
                                &text,
                                start,
                                "text-match",
                            ))
                        }
                        paragraph.clear();
                        start = i as u32 + 2;
                    } else {
                        paragraph.push_str(line);
                        paragraph.push('\n')
                    }
                }
            }
        }
    }
    if candidates.len() == 1 {
        Ok((
            candidates.pop(),
            "通过唯一段落文字匹配定位；请核对 LaTeX 命令与引用。".into(),
        ))
    } else {
        Ok((None,format!("未可靠定位源码（{}）；已保留 PDF 页码、选文和坐标，请 AI 按原文核对，不要猜测行号。",hit.err().unwrap_or_else(||"匹配存在歧义".into()))))
    }
}
#[tauri::command]
pub async fn pdf_list_annotations(
    project: String,
    pdf: Option<String>,
) -> Result<Vec<Annotation>, String> {
    let _guard = LOCK.lock().await;
    Ok(with_versions(&project, load(&project).await?)
        .await?
        .into_iter()
        .filter(|a| pdf.as_ref().is_none_or(|p| a.pdf == *p))
        .collect())
}
pub async fn add_annotation(
    project: String,
    mut annotation: Annotation,
) -> Result<Annotation, String> {
    if annotation.quote.trim().is_empty()
        || annotation.comment.trim().is_empty()
        || annotation.quote.len() > 20000
        || annotation.comment.len() > 10000
        || !["highlight", "underline"].contains(&annotation.style.as_str())
        || annotation.marks.is_empty()
        || annotation.marks.len() > 200
    {
        return Err("请选择 PDF 文字并填写批注（选文上限 20000 字节）".into());
    }
    for m in &annotation.marks {
        if m.page == 0
            || ![m.x, m.y, m.width, m.height, m.page_width, m.page_height]
                .iter()
                .all(|v| v.is_finite())
            || m.x < 0.
            || m.y < 0.
            || m.width <= 0.
            || m.height <= 0.
            || m.x + m.width > 1.01
            || m.y + m.height > 1.01
            || m.page_width <= 0.
            || m.page_height <= 0.
        {
            return Err("无效的 PDF 选区坐标".into());
        }
    }
    let (source, note) = locate(
        &project,
        &annotation.pdf,
        &annotation.marks[0],
        &annotation.quote,
    )
    .await?;
    annotation.source = source;
    annotation.mapping_note = note;
    annotation.id = uuid::Uuid::new_v4().to_string();
    annotation.created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    annotation.kind = "pdf".into();
    annotation.anchor = None;
    annotation.resolved = false;
    annotation.resolution.clear();
    let _guard = LOCK.lock().await;
    let mut items = load(&project).await?;
    let previous = items.clone();
    annotation.events.clear();
    annotation.submitted_to = None;
    record(&mut annotation, "created");
    let event_id = annotation.events.last().unwrap().id.clone();
    items.push(annotation.clone());
    let hash = commit_change(
        &project,
        &previous,
        &items,
        "Writer PDF · 保存批注",
        &[event_id],
    )
    .await?;
    annotation.events.last_mut().unwrap().git_hash = Some(hash);
    Ok(annotation)
}
pub async fn update_annotation(
    project: String,
    id: String,
    comment: Option<String>,
    resolved: Option<bool>,
    resolution: Option<String>,
) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let mut items = load(&project).await?;
    let previous = items.clone();
    let item = items.iter_mut().find(|a| a.id == id).ok_or("找不到批注")?;
    let old_comment = item.comment.clone();
    let old_resolution = item.resolution.clone();
    let old_resolved = item.resolved;
    let action = if resolved == Some(true) {
        "resolved"
    } else if resolved == Some(false) {
        "reopened"
    } else {
        "edited"
    };
    if let Some(comment) = comment {
        if comment.trim().is_empty() || comment.len() > 10000 {
            return Err("批注不能为空或过长".into());
        }
        if item.comment != comment {
            item.resolved = false;
            item.resolution.clear();
        }
        item.comment = comment;
    }
    if let Some(resolved) = resolved {
        item.resolved = resolved;
        if !resolved {
            item.resolution.clear();
        }
    }
    if let Some(note) = resolution {
        item.resolution = note.chars().take(10000).collect();
    }
    if old_comment == item.comment
        && old_resolution == item.resolution
        && old_resolved == item.resolved
        && !item.events.is_empty()
    {
        return Ok(());
    }
    item.submitted_to = None;
    record(item, action);
    let event_id = item.events.last().unwrap().id.clone();
    commit_change(
        &project,
        &previous,
        &items,
        if action == "resolved" {
            "Writer PDF · 解决批注与修改后版本"
        } else {
            "Writer PDF · 更新批注"
        },
        &[event_id],
    )
    .await?;
    Ok(())
}
pub(crate) fn record(item: &mut Annotation, action: &str) {
    item.events.push(AnnotationEvent {
        id: uuid::Uuid::new_v4().to_string(),
        action: action.into(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        comment: item.comment.clone(),
        resolution: item.resolution.clone(),
        resolved: item.resolved,
        git_hash: None,
    });
}
pub(crate) async fn commit_change(
    project: &str,
    previous: &[Annotation],
    next: &[Annotation],
    label: &str,
    events: &[String],
) -> Result<String, String> {
    save(project, next).await?;
    match super::git_snapshots::create_snapshot(project, Some(label), events).await {
        Ok(version) => Ok(version.hash),
        Err(error) => {
            save(project, previous).await.map_err(|restore| {
                format!("Git 保存失败：{error}；批注回退也失败：{restore}。请保留项目并重试。")
            })?;
            Err(format!("Git 版本保存失败，批注状态未更改：{error}"))
        }
    }
}
async fn with_versions(
    project: &str,
    mut items: Vec<Annotation>,
) -> Result<Vec<Annotation>, String> {
    if items.is_empty() {
        return Ok(items);
    }
    let versions = super::git_snapshots::annotation_versions(project).await?;
    for item in &mut items {
        for event in &mut item.events {
            event.git_hash = versions.get(&event.id).cloned();
        }
    }
    Ok(items)
}
async fn ensure_versions(project: &str) -> Result<(), String> {
    let _guard = LOCK.lock().await;
    let mut items = load(project).await?;
    let previous = items.clone();
    let mut events = vec![];
    for item in &mut items {
        if item.events.is_empty() {
            record(item, "baseline");
            events.push(item.events.last().unwrap().id.clone());
        }
    }
    if !events.is_empty() {
        commit_change(
            project,
            &previous,
            &items,
            "Writer PDF · 现有批注基线",
            &events,
        )
        .await?;
    }
    Ok(())
}
async fn prepare_annotations(project: &str, ids: &[String], backend: &str) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 100 || super::harness::Harness::parse(backend).is_err() {
        return Err("无效的批注提交".into());
    }
    let _guard = LOCK.lock().await;
    let mut items = load(project).await?;
    let previous = items.clone();
    let mut events = vec![];
    for id in ids {
        let item = items
            .iter_mut()
            .find(|item| item.id == *id)
            .ok_or("批注不存在")?;
        if item.resolved {
            return Err("已解决的批注请先重新打开".into());
        }
        item.submitted_to = Some(backend.into());
        record(item, "submitted");
        events.push(item.events.last().unwrap().id.clone());
    }
    commit_change(
        project,
        &previous,
        &items,
        "Writer PDF · 提交批注与修改前版本",
        &events,
    )
    .await?;
    Ok(())
}
fn announce(app: &AppHandle, project: &str) {
    let _ = app.emit(
        "writer://annotations-changed",
        serde_json::json!({"project":project}),
    );
}
#[tauri::command]
pub async fn pdf_add_annotation(
    app: AppHandle,
    project: String,
    annotation: Annotation,
) -> Result<Annotation, String> {
    let result = add_annotation(project.clone(), annotation).await;
    announce(&app, &project);
    result
}
#[tauri::command]
pub async fn pdf_update_annotation(
    app: AppHandle,
    project: String,
    id: String,
    comment: Option<String>,
    resolved: Option<bool>,
    resolution: Option<String>,
) -> Result<(), String> {
    let result = update_annotation(project.clone(), id, comment, resolved, resolution).await;
    announce(&app, &project);
    result
}
#[tauri::command]
pub async fn pdf_ensure_annotation_versions(app: AppHandle, project: String) -> Result<(), String> {
    let result = ensure_versions(&project).await;
    announce(&app, &project);
    result
}
#[tauri::command]
pub async fn pdf_prepare_annotations(
    app: AppHandle,
    project: String,
    ids: Vec<String>,
    backend: String,
) -> Result<(), String> {
    let result = prepare_annotations(&project, &ids, &backend).await;
    announce(&app, &project);
    result
}

pub async fn for_ai(project: &str, ids: Option<&Vec<String>>) -> Result<serde_json::Value, String> {
    super::source_annotations::for_ai(project, ids).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn keeps_notes_durable_and_reports_source_changes() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        tokio::fs::write(
            dir.path().join("main.tex"),
            "First unique paragraph about testing.\n\nSecond paragraph.",
        )
        .await
        .unwrap();
        let source = context_at(
            "main.tex".into(),
            "First unique paragraph about testing.\n\nSecond paragraph.",
            1,
            "text-match",
        );
        let item = Annotation {
            kind: "pdf".into(),
            anchor: None,
            id: "note".into(),
            pdf: "main.pdf".into(),
            quote: "First unique paragraph".into(),
            comment: "Rephrase carefully".into(),
            style: "underline".into(),
            marks: vec![],
            fingerprint: "test".into(),
            created_at: 1,
            resolved: false,
            source: Some(source),
            mapping_note: "matched".into(),
            resolution: String::new(),
            events: vec![],
            submitted_to: None,
        };
        save(&project, &[item]).await.unwrap();
        assert_eq!(load(&project).await.unwrap().len(), 1);
        assert_eq!(
            for_ai(&project, None).await.unwrap()["annotations"][0]["sourceChanged"],
            false
        );
        tokio::fs::write(dir.path().join("main.tex"), "Edited paragraph.")
            .await
            .unwrap();
        assert_eq!(
            for_ai(&project, None).await.unwrap()["annotations"][0]["sourceChanged"],
            true
        );
        update_annotation(
            project.clone(),
            "note".into(),
            None,
            Some(true),
            Some("verified".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            for_ai(&project, None).await.unwrap()["annotations"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(load(&project).await.unwrap()[0].resolution, "verified");
    }
    #[tokio::test]
    async fn rejects_traversal_and_corrupt_history() {
        let dir = tempfile::tempdir().unwrap();
        assert!(project_file(dir.path(), "../secret").await.is_err());
        let project = dir.path().to_str().unwrap();
        let path = store_path(project).await.unwrap();
        tokio::fs::write(&path, "broken").await.unwrap();
        assert!(load(project).await.is_err());
        assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), "broken");
    }
}

#[cfg(test)]
mod mapping_tests {
    use super::*;
    #[tokio::test]
    async fn unique_text_fallback_locates_a_tex_paragraph_but_ambiguous_text_stays_unmapped() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_str().unwrap();
        tokio::fs::write(dir.path().join("main.pdf"), b"%PDF-test")
            .await
            .unwrap();
        let text = "\\section{Test}\n\nA unique scientific workflow sentence.\n\nOther text.\n";
        tokio::fs::write(dir.path().join("main.tex"), text)
            .await
            .unwrap();
        let mark = Mark {
            page: 1,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.02,
            page_width: 600.,
            page_height: 800.,
        };
        let (source, _) = locate(
            project,
            "main.pdf",
            &mark,
            "A unique scientific workflow sentence.",
        )
        .await
        .unwrap();
        let source = source.unwrap();
        assert_eq!(source.file, "main.tex");
        assert_eq!(source.line, 3);
        assert_eq!(source.method, "text-match");
        tokio::fs::write(dir.path().join("other.tex"), text)
            .await
            .unwrap();
        assert!(locate(
            project,
            "main.pdf",
            &mark,
            "A unique scientific workflow sentence."
        )
        .await
        .unwrap()
        .0
        .is_none());
    }
}

#[cfg(test)]
mod version_tests {
    use super::*;
    async fn fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        tokio::fs::write(dir.path().join("main.tex"), "The original paragraph.")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join(".gitignore"), ".writer/\n")
            .await
            .unwrap();
        let item:Annotation=serde_json::from_value(serde_json::json!({"id":"note","pdf":"main.pdf","quote":"The original paragraph.","comment":"Make the paragraph clearer.","style":"highlight","marks":[],"fingerprint":"pdf-v1","createdAt":1,"resolved":false,"source":null,"mappingNote":"test","resolution":""})).unwrap();
        save(&project, &[item]).await.unwrap();
        (dir, project)
    }
    #[tokio::test]
    async fn versions_capture_notes_before_and_paper_after_resolution() {
        let (dir, project) = fixture().await;
        ensure_versions(&project).await.unwrap();
        ensure_versions(&project).await.unwrap();
        let baseline = pdf_list_annotations(project.clone(), None)
            .await
            .unwrap()
            .remove(0);
        assert_eq!(baseline.events.len(), 1);
        let first = baseline.events[0].git_hash.clone().unwrap();
        let first_json = super::super::git_snapshots::git_snapshot_file(
            project.clone(),
            first.clone(),
            ".writer/pdf-annotations.json".into(),
        )
        .await
        .unwrap();
        assert!(!serde_json::from_str::<Vec<Annotation>>(&first_json).unwrap()[0].resolved);
        update_annotation(
            project.clone(),
            "note".into(),
            Some("Clarify the evidence.".into()),
            None,
            None,
        )
        .await
        .unwrap();
        prepare_annotations(&project, &["note".into()], "claude")
            .await
            .unwrap();
        tokio::fs::write(
            dir.path().join("main.tex"),
            "The revised, evidence-based paragraph.",
        )
        .await
        .unwrap();
        update_annotation(
            project.clone(),
            "note".into(),
            None,
            Some(true),
            Some("Revised and verified.".into()),
        )
        .await
        .unwrap();
        let completed = pdf_list_annotations(project.clone(), None)
            .await
            .unwrap()
            .remove(0);
        assert!(completed.resolved);
        assert_eq!(completed.events.len(), 4);
        assert!(completed.events.iter().all(|e| e.git_hash.is_some()));
        let last = completed.events.last().unwrap().git_hash.clone().unwrap();
        assert_ne!(first, last);
        assert_eq!(
            super::super::git_snapshots::git_snapshot_file(
                project.clone(),
                first,
                "main.tex".into()
            )
            .await
            .unwrap(),
            "The original paragraph."
        );
        assert_eq!(
            super::super::git_snapshots::git_snapshot_file(
                project.clone(),
                last.clone(),
                "main.tex".into()
            )
            .await
            .unwrap(),
            "The revised, evidence-based paragraph."
        );
        let saved = super::super::git_snapshots::git_snapshot_file(
            project.clone(),
            last,
            ".writer/pdf-annotations.json".into(),
        )
        .await
        .unwrap();
        assert!(serde_json::from_str::<Vec<Annotation>>(&saved).unwrap()[0].resolved);
        // Periodic snapshots must retain notes even with .writer/ ignored by ordinary Git.
        assert!(
            !super::super::git_snapshots::git_create_snapshot(project.clone())
                .await
                .unwrap()
                .created
        );
        // Editing the request after resolution must reopen it instead of keeping a green status.
        update_annotation(
            project.clone(),
            "note".into(),
            Some("Please verify the new claim too.".into()),
            None,
            None,
        )
        .await
        .unwrap();
        let reopened = pdf_list_annotations(project.clone(), None)
            .await
            .unwrap()
            .remove(0);
        assert!(!reopened.resolved);
        assert!(reopened.resolution.is_empty());
        assert_eq!(reopened.events.last().unwrap().action, "edited");
        // No self-referential hashes or a second dirty metadata write.
        assert!(load(&project).await.unwrap()[0]
            .events
            .iter()
            .all(|e| e.git_hash.is_none()));
    }
    #[tokio::test]
    async fn git_failure_rolls_back_status_and_history_without_touching_the_manuscript() {
        let (dir, project) = fixture().await;
        ensure_versions(&project).await.unwrap();
        let original = tokio::fs::read(dir.path().join(".writer/pdf-annotations.json"))
            .await
            .unwrap();
        let lock = dir.path().join(".git/refs/writer/snapshots.lock");
        tokio::fs::write(&lock, "held by another writer")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("main.tex"), "User's current edits.")
            .await
            .unwrap();
        let error = update_annotation(
            project.clone(),
            "note".into(),
            None,
            Some(true),
            Some("verified".into()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("Git"));
        assert_eq!(
            tokio::fs::read(dir.path().join(".writer/pdf-annotations.json"))
                .await
                .unwrap(),
            original
        );
        assert!(!pdf_list_annotations(project.clone(), None).await.unwrap()[0].resolved);
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("main.tex"))
                .await
                .unwrap(),
            "User's current edits."
        );
        tokio::fs::remove_file(lock).await.unwrap();
        update_annotation(
            project.clone(),
            "note".into(),
            None,
            Some(true),
            Some("verified".into()),
        )
        .await
        .unwrap();
        assert!(pdf_list_annotations(project, None).await.unwrap()[0].resolved);
    }
}

/// Restore historical selection text only with the exact source PDF fingerprint,
/// verified glyph mappings and an exact match in the saved TeX context.
pub async fn repair_annotation_quotes(project: String) -> Result<usize, String> {
    let _guard = LOCK.lock().await;
    let mut items = load(&project).await?;
    let previous = items.clone();
    let candidates: Vec<_> = items
        .iter()
        .filter(|n| {
            n.kind != "text" && super::pdf_text::suspicious_quote(&n.quote) && n.source.is_some()
        })
        .collect();
    if candidates.is_empty() {
        return Ok(0);
    }
    let versions = super::git_snapshots::annotation_versions(&project).await?;
    let mut groups: std::collections::BTreeMap<(String, String), Vec<&Annotation>> =
        std::collections::BTreeMap::new();
    for item in candidates {
        groups
            .entry((item.pdf.clone(), item.fingerprint.clone()))
            .or_default()
            .push(item);
    }
    let mut all_changes = vec![];
    for ((pdf, fingerprint), notes) in groups {
        let sources: Vec<super::pdf_text::QuoteCandidate> = notes
            .iter()
            .filter_map(|n| {
                n.source
                    .as_ref()
                    .map(|source| (n.id.clone(), n.quote.clone(), source.context.clone()))
            })
            .collect();
        let mut hashes = std::collections::HashSet::new();
        for event in notes.iter().flat_map(|n| n.events.iter()) {
            let Some(hash) = versions.get(&event.id) else {
                continue;
            };
            if !hashes.insert(hash.clone()) {
                continue;
            }
            let Ok(bytes) = super::git_snapshots::git_snapshot_bytes(&project, hash, &pdf).await
            else {
                continue;
            };
            let fingerprint = fingerprint.clone();
            let sources = sources.clone();
            let recovered = tokio::task::spawn_blocking(move || {
                super::pdf_text::recover_saved_quotes(&bytes, &fingerprint, &sources)
            })
            .await
            .map_err(|e| e.to_string())??;
            if let Some(changes) = recovered {
                all_changes.extend(changes);
                break;
            }
        }
    }
    if all_changes.is_empty() {
        return Ok(0);
    }
    let mut events = vec![];
    let count = all_changes.len();
    for (id, quote) in all_changes {
        if let Some(note) = items.iter_mut().find(|n| n.id == id) {
            note.quote = quote;
            note.mapping_note
                .push_str(" 已根据原 PDF 字体映射与保存的源码校正选文。");
            record(note, "quote_repaired");
            events.push(note.events.last().unwrap().id.clone());
        }
    }
    commit_change(
        &project,
        &previous,
        &items,
        "Writer PDF · 修复历史选文乱码",
        &events,
    )
    .await?;
    Ok(count)
}
#[tauri::command]
pub async fn pdf_repair_annotation_quotes(
    app: AppHandle,
    project: String,
) -> Result<usize, String> {
    let result = repair_annotation_quotes(project.clone()).await;
    announce(&app, &project);
    result
}
#[cfg(test)]
mod quote_repair_integration {
    use super::*;
    #[tokio::test]
    #[ignore = "requires an isolated copy of a project with Writer Git snapshots"]
    async fn repairs_saved_quotes_and_preserves_comments_and_status() {
        let project = std::env::var("WRITER_QUOTE_QA_PROJECT").unwrap();
        let before = load(&project).await.unwrap();
        let n = repair_annotation_quotes(project.clone()).await.unwrap();
        assert_eq!(n, 3);
        let after = load(&project).await.unwrap();
        for (old, new) in before.iter().zip(after.iter()) {
            assert_eq!(old.comment, new.comment);
            assert_eq!(old.resolved, new.resolved);
            assert_eq!(old.resolution, new.resolution);
            if super::super::pdf_text::suspicious_quote(&old.quote) {
                assert!(!super::super::pdf_text::suspicious_quote(&new.quote));
            }
        }
        assert_eq!(repair_annotation_quotes(project.clone()).await.unwrap(), 0);
        assert!(!super::super::git_snapshots::annotation_versions(&project)
            .await
            .unwrap()
            .is_empty());
    }
}
