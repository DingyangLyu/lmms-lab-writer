//! Optimistic, revision-based document edits shared by the editor and Writer MCP.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{Algorithm, DiffTag};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::fs;
const LIMIT: usize = 2_000_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergePart {
    pub text: Option<String>,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub content: Option<String>,
    pub parts: Vec<MergePart>,
    pub conflicts: usize,
}
#[derive(Clone, Debug)]
struct Edit {
    start: usize,
    end: usize,
    text: String,
    side: u8,
}
/// ASCII identifiers and TeX commands stay atomic; CJK is split into characters,
/// so independent changes in a long, soft-wrapped paragraph can merge.
fn tokens(text: &str) -> (Vec<&str>, Vec<usize>) {
    let mut offsets = vec![0];
    let mut previous = false;
    for (i, c) in text.char_indices() {
        let word = c.is_ascii_alphanumeric() || c == '_' || c == '\\';
        if i > 0 && !(word && previous) {
            offsets.push(i);
        }
        previous = word;
    }
    if *offsets.last().unwrap() != text.len() {
        offsets.push(text.len());
    }
    let values = offsets.windows(2).map(|r| &text[r[0]..r[1]]).collect();
    (values, offsets)
}
fn edits(base: &str, new: &str, side: u8) -> Vec<Edit> {
    let (a, ap) = tokens(base);
    let (b, _) = tokens(new);
    similar::capture_diff_slices_deadline(
        Algorithm::Myers,
        &a,
        &b,
        Some(Instant::now() + Duration::from_millis(600)),
    )
    .into_iter()
    .filter_map(|op| {
        if op.tag() == DiffTag::Equal {
            return None;
        }
        let old = op.old_range();
        let new = op.new_range();
        Some(Edit {
            start: ap[old.start],
            end: ap[old.end],
            text: new.clone().map(|i| b[i]).collect(),
            side,
        })
    })
    .collect()
}
fn apply(base: &str, start: usize, end: usize, changes: &[Edit], side: u8) -> String {
    let mut result = String::new();
    let mut cursor = start;
    for e in changes.iter().filter(|e| e.side == side) {
        result.push_str(&base[cursor..e.start]);
        result.push_str(&e.text);
        cursor = e.end;
    }
    result.push_str(&base[cursor..end]);
    result
}
fn plain(text: String) -> MergePart {
    MergePart {
        text: Some(text),
        base: None,
        ours: None,
        theirs: None,
    }
}
pub fn merge(base: &str, ours: &str, theirs: &str) -> MergeResult {
    let clean = |s: &str| MergeResult {
        content: Some(s.into()),
        parts: vec![plain(s.into())],
        conflicts: 0,
    };
    if ours == theirs {
        return clean(ours);
    }
    if ours == base {
        return clean(theirs);
    }
    if theirs == base {
        return clean(ours);
    }
    let mut all = edits(base, ours, 0);
    all.extend(edits(base, theirs, 1));
    all.sort_by_key(|e| (e.start, e.end, e.side));
    let mut parts = vec![];
    let mut cursor = 0;
    let mut i = 0;
    let mut conflicts = 0;
    while i < all.len() {
        let start = all[i].start;
        let mut end = all[i].end;
        let mut j = i + 1;
        while j < all.len()
            && (all[j].start < end
                || (start == end && all[j].start == start && all[j].end == start))
        {
            end = end.max(all[j].end);
            j += 1;
        }
        if cursor < start {
            parts.push(plain(base[cursor..start].into()));
        }
        let ours = apply(base, start, end, &all[i..j], 0);
        let theirs = apply(base, start, end, &all[i..j], 1);
        let original = &base[start..end];
        if ours == theirs || theirs == original {
            parts.push(plain(ours));
        } else if ours == original {
            parts.push(plain(theirs));
        } else {
            conflicts += 1;
            parts.push(MergePart {
                text: None,
                base: Some(original.into()),
                ours: Some(ours),
                theirs: Some(theirs),
            });
        }
        cursor = end;
        i = j;
    }
    if cursor < base.len() {
        parts.push(plain(base[cursor..].into()));
    }
    let content =
        (conflicts == 0).then(|| parts.iter().filter_map(|p| p.text.as_deref()).collect());
    MergeResult {
        content,
        parts,
        conflicts,
    }
}
fn bounded(text: &str) -> Result<(), String> {
    if text.len() > LIMIT {
        Err("文本超过 2 MB，无法自动合并，请先拆分文件。".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn merge_document_text(
    base: String,
    ours: String,
    theirs: String,
) -> Result<MergeResult, String> {
    for text in [&base, &ours, &theirs] {
        bounded(text)?;
    }
    tokio::task::spawn_blocking(move || merge(&base, &ours, &theirs))
        .await
        .map_err(|e| e.to_string())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub path: String,
    pub content: String,
}
async fn metadata_dir(project: &str, kind: &str) -> Result<std::path::PathBuf, String> {
    let root = super::annotations::root(project).await?;
    let dir = root.join(".writer").join(kind);
    let mut existing = dir.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("无效元数据路径")?;
    }
    if !fs::canonicalize(existing)
        .await
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("元数据目录超出当前项目".into());
    }
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    Ok(dir)
}
fn identifier(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        Err("无效版本标识".into())
    } else {
        Ok(())
    }
}
async fn read_metadata(file: &std::path::Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(file)
        .await
        .map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 20_000_000 {
        return Err("无效或过大的版本元数据".into());
    }
    fs::read(file).await.map_err(|e| e.to_string())
}
pub async fn snapshot(project: &str, path: &str, content: &str) -> Result<Revision, String> {
    bounded(content)?;
    if path.split('/').any(|part| part.starts_with('.'))
        || ["auth.json", "credentials.json"].contains(&path.rsplit('/').next().unwrap_or(""))
    {
        return Err("此内部或凭据文件不能作为文稿版本保存。".into());
    }
    super::saving::target_path(project, path).await?;
    let id = format!("{:x}", Sha256::digest(format!("{path}\0{content}")));
    let value = Revision {
        id: id.clone(),
        path: path.into(),
        content: content.into(),
    };
    let file = metadata_dir(project, "revisions")
        .await?
        .join(format!("{id}.json"));
    if !file.exists() {
        super::saving::atomic_write(
            &file,
            &serde_json::to_vec(&value).map_err(|e| e.to_string())?,
        )
        .await?;
    }
    Ok(value)
}
pub async fn revision(project: &str, id: &str, path: &str) -> Result<Revision, String> {
    identifier(id)?;
    let file = metadata_dir(project, "revisions")
        .await?
        .join(format!("{id}.json"));
    let data: Revision = serde_json::from_slice(
        &read_metadata(&file)
            .await
            .map_err(|_| "基准版本不存在或无效，请重新读取文档版本。")?,
    )
    .map_err(|e| e.to_string())?;
    if data.path != path
        || data.id != id
        || format!(
            "{:x}",
            Sha256::digest(format!("{}\0{}", data.path, data.content))
        ) != id
    {
        return Err("版本不属于此文件或内容校验失败".into());
    }
    Ok(data)
}
#[tauri::command]
pub async fn read_document_revision(project: String, path: String) -> Result<Revision, String> {
    let (_, target) = super::saving::target_path(&project, &path).await?;
    let content = fs::read_to_string(target)
        .await
        .map_err(|e| e.to_string())?;
    snapshot(&project, &path, &content).await
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub revision: String,
    pub path: String,
    pub owner: String,
    pub annotation_id: Option<String>,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub disk: String,
    pub parts: Vec<MergePart>,
    pub updated_at: u64,
    pub status: String,
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub status: String,
    pub content: String,
    pub merged: bool,
    pub conflict: Option<Conflict>,
    pub version_error: Option<String>,
}
async fn store_conflict(project: &str, value: &Conflict) -> Result<(), String> {
    let file = metadata_dir(project, "conflicts")
        .await?
        .join(format!("{}.json", value.id));
    super::saving::atomic_write(
        &file,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .await
}
/// Cooperative writers use SAVE_LOCK, then check disk again immediately before
/// atomic replacement. A raw external writer cannot participate in this lock.
pub async fn save(
    project: &str,
    path: &str,
    base: &str,
    proposal: &str,
    owner: &str,
    annotation_id: Option<String>,
) -> Result<SaveResult, String> {
    bounded(base)?;
    bounded(proposal)?;
    let _guard = super::saving::SAVE_LOCK.lock().await;
    save_inner(project, path, base, proposal, owner, annotation_id).await
}
async fn save_inner(
    project: &str,
    path: &str,
    base: &str,
    proposal: &str,
    owner: &str,
    annotation_id: Option<String>,
) -> Result<SaveResult, String> {
    let (root, target) = super::saving::target_path(project, path).await?;
    for _ in 0..3 {
        let disk = fs::read_to_string(&target)
            .await
            .map_err(|e| format!("无法读取文件，修改已保留：{e}"))?;
        bounded(&disk)?;
        let (ours, theirs) = if owner == "editor" {
            (proposal, &disk[..])
        } else {
            (&disk[..], proposal)
        };
        let b = base.to_string();
        let o = ours.to_string();
        let t = theirs.to_string();
        let result = tokio::task::spawn_blocking(move || merge(&b, &o, &t))
            .await
            .map_err(|e| e.to_string())?;
        let identity = if owner == "editor" {
            format!("{path}\0{owner}")
        } else {
            format!(
                "{path}\0{owner}\0{}\0{base}\0{proposal}",
                annotation_id.as_deref().unwrap_or("")
            )
        };
        let id = format!("{:x}", Sha256::digest(identity));
        if owner != "editor" {
            let record = metadata_dir(project, "conflicts")
                .await?
                .join(format!("{id}.json"));
            if let Ok(bytes) = read_metadata(&record).await {
                if let Ok(prior) = serde_json::from_slice::<Conflict>(&bytes) {
                    if ["resolved", "superseded"].contains(&prior.status.as_str()) {
                        return Ok(SaveResult {
                            status: "reviewed".into(),
                            content: disk,
                            merged: false,
                            conflict: None,
                            version_error: None,
                        });
                    }
                }
            }
        }
        if let Some(content) = result.content {
            super::saving::create_backup(&root, &target, &disk).await?;
            if fs::read_to_string(&target)
                .await
                .map_err(|e| e.to_string())?
                != disk
            {
                continue;
            }
            if content != disk {
                super::saving::atomic_write(&target, content.as_bytes()).await?;
            }
            // Preserve the successfully saved user version as well as its predecessor.
            let mut version_error = super::saving::create_backup(&root, &target, &content)
                .await
                .err()
                .map(|e| format!("文稿已保存，但保存后备份失败：{e}"));
            let record = metadata_dir(project, "conflicts")
                .await?
                .join(format!("{id}.json"));
            if let Ok(bytes) = read_metadata(&record).await {
                if let Ok(mut prior) = serde_json::from_slice::<Conflict>(&bytes) {
                    if prior.status == "pending" {
                        prior.status = "merged".into();
                        prior.updated_at = now();
                        if let Err(e) = store_conflict(project, &prior).await {
                            version_error = Some(format!("文稿已保存，但冲突状态更新失败：{e}"));
                        }
                    }
                }
            }
            return Ok(SaveResult {
                status: "saved".into(),
                merged: content != proposal,
                content,
                conflict: None,
                version_error,
            });
        }
        let revision = format!(
            "{:x}",
            Sha256::digest(format!("{base}\0{ours}\0{theirs}\0{disk}"))
        );
        let conflict = Conflict {
            id,
            revision,
            path: path.into(),
            owner: owner.into(),
            annotation_id: annotation_id.clone(),
            base: base.into(),
            ours: ours.into(),
            theirs: theirs.into(),
            disk: disk.clone(),
            parts: result.parts,
            updated_at: now(),
            status: "pending".into(),
        };
        store_conflict(project, &conflict).await?;
        return Ok(SaveResult {
            status: "conflict".into(),
            content: disk,
            merged: false,
            conflict: Some(conflict),
            version_error: None,
        });
    }
    Err("文件仍在连续变化，本次修改已保留，请稍后重试合并。".into())
}
#[tauri::command]
pub async fn merge_save_document(
    app: AppHandle,
    project: String,
    path: String,
    content: String,
    expected: String,
) -> Result<SaveResult, String> {
    let result = save(&project, &path, &expected, &content, "editor", None).await;
    let _ = app.emit(
        "writer://conflicts-changed",
        serde_json::json!({"project":project}),
    );
    result
}
#[tauri::command]
pub async fn list_document_conflicts(project: String) -> Result<Vec<Conflict>, String> {
    let mut result = vec![];
    let mut entries = fs::read_dir(metadata_dir(&project, "conflicts").await?)
        .await
        .map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        if entry.path().extension().is_some_and(|e| e == "json") {
            if let Ok(bytes) = read_metadata(&entry.path()).await {
                if let Ok(value) = serde_json::from_slice::<Conflict>(&bytes) {
                    if value.status == "pending" {
                        result.push(value);
                    }
                }
            }
        }
    }
    result.sort_by_key(|c| std::cmp::Reverse(c.updated_at));
    Ok(result)
}
pub async fn resolve_conflict(
    project: &str,
    id: &str,
    expected_revision: &str,
    content: &str,
) -> Result<SaveResult, String> {
    identifier(id)?;
    bounded(content)?;
    let _guard = super::saving::SAVE_LOCK.lock().await;
    let file = metadata_dir(project, "conflicts")
        .await?
        .join(format!("{id}.json"));
    let mut conflict: Conflict =
        serde_json::from_slice(&read_metadata(&file).await?).map_err(|e| e.to_string())?;
    if conflict.status != "pending" || conflict.revision != expected_revision {
        return Err("冲突记录已更新，请重新查看最新双方内容。".into());
    }
    let mut result = save_inner(
        project,
        &conflict.path,
        &conflict.disk,
        content,
        &conflict.owner,
        conflict.annotation_id.clone(),
    )
    .await?;
    if result.status == "saved"
        || result
            .conflict
            .as_ref()
            .is_some_and(|c| c.id != conflict.id)
    {
        conflict.status = if result.status == "saved" {
            "resolved"
        } else {
            "superseded"
        }
        .into();
        conflict.updated_at = now();
        if let Err(e) = store_conflict(project, &conflict).await {
            result.version_error = Some(format!("结果已保存，但冲突状态更新失败：{e}"));
        }
        if let Err(e) =
            super::git_snapshots::create_snapshot(project, Some("Writer · 解决文稿合并冲突"), &[])
                .await
        {
            result.version_error = Some(format!("内容已保存，但 Git 版本保存失败：{e}"));
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn resolve_document_conflict(
    app: AppHandle,
    project: String,
    id: String,
    expected_revision: String,
    content: String,
) -> Result<SaveResult, String> {
    let result = resolve_conflict(&project, &id, &expected_revision, &content).await;
    let _ = app.emit(
        "writer://conflicts-changed",
        serde_json::json!({"project":project}),
    );
    result
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub old_text: String,
    pub new_text: String,
    pub start: Option<usize>,
}
pub fn utf16_byte(text: &str, offset: usize) -> Option<usize> {
    let mut n = 0;
    for (i, c) in text.char_indices() {
        if n == offset {
            return Some(i);
        }
        n += c.len_utf16();
        if n > offset {
            return None;
        }
    }
    (n == offset).then_some(text.len())
}
pub fn patch(base: &str, edits: &[TextEdit]) -> Result<String, String> {
    if edits.is_empty() || edits.len() > 64 {
        return Err("请提供 1–64 个明确的替换片段".into());
    }
    let mut spans = vec![];
    for e in edits {
        if e.old_text.is_empty() {
            return Err("oldText 不能为空，请提供插入位置附近的原文。".into());
        }
        let start = if let Some(start) = e.start {
            utf16_byte(base, start)
                .filter(|p| base[*p..].starts_with(&e.old_text))
                .ok_or("指定位置与基准原文不一致")?
        } else {
            let found: Vec<_> = base
                .match_indices(&e.old_text)
                .map(|(p, _)| p)
                .take(2)
                .collect();
            if found.len() != 1 {
                return Err("基准原文不存在或有多处，请提供 start（UTF-16 偏移）明确定位。".into());
            }
            found[0]
        };
        spans.push((start, start + e.old_text.len(), &e.new_text));
    }
    spans.sort_by_key(|e| e.0);
    if spans.windows(2).any(|w| w[0].1 > w[1].0) {
        return Err("替换片段相互重叠".into());
    }
    let mut result = base.to_string();
    for (start, end, text) in spans.into_iter().rev() {
        result.replace_range(start..end, text);
    }
    bounded(&result)?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merges_independent_chinese_changes_in_one_line() {
        let r = merge(
            "这里讨论材料与方法。",
            "这里讨论新材料与方法。",
            "这里讨论材料与实验方法。",
        );
        assert_eq!(r.content.as_deref(), Some("这里讨论新材料与实验方法。"));
    }
    #[test]
    fn never_combines_two_edits_to_the_same_identifier() {
        assert_eq!(merge("cat", "bat", "car").conflicts, 1);
    }
    #[test]
    fn same_edit_is_idempotent_and_adjacent_insertions_are_kept() {
        assert_eq!(
            merge("abc", "new abc", "new abc").content.as_deref(),
            Some("new abc")
        );
        assert_eq!(
            merge("甲乙", "前甲乙", "甲丙").content.as_deref(),
            Some("前甲丙")
        );
    }
    #[test]
    fn handles_deletion_and_emoji() {
        assert_eq!(
            merge("甲😀乙丙", "甲😀乙", "新甲😀乙丙").content.as_deref(),
            Some("新甲😀乙")
        );
        assert_eq!(utf16_byte("a😀b", 2), None);
        assert_eq!(utf16_byte("a😀b", 3), Some(5));
    }
    #[test]
    fn overlaps_preserve_all_three_versions() {
        let r = merge("原稿", "我的版本", "其他版本");
        assert!(r.conflicts > 0);
        assert!(r.content.is_none());
        assert!(r
            .parts
            .iter()
            .any(|p| p.ours.is_some() && p.theirs.is_some() && p.base.is_some()));
    }
    #[test]
    fn ambiguous_patch_requires_offset() {
        let e = TextEdit {
            old_text: "甲".into(),
            new_text: "乙".into(),
            start: None,
        };
        assert!(patch("甲甲", &[e]).is_err());
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRange {
    pub start: usize,
    pub end: usize,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedRange {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub state: String,
    pub line: usize,
    pub end_line: usize,
}
fn map_position(position: usize, changes: &[Edit], right: bool) -> usize {
    let mut delta: isize = 0;
    for e in changes {
        if e.start == e.end && e.start == position && !right {
            break;
        }
        if e.end <= position {
            delta += e.text.len() as isize - (e.end - e.start) as isize;
        } else if e.start < position {
            return (e.start as isize + delta) as usize + if right { 0 } else { e.text.len() };
        } else {
            break;
        }
    }
    (position as isize + delta).max(0) as usize
}
pub fn locate_range(
    base: &str,
    current: &str,
    range: &AnchorRange,
) -> Result<LocatedRange, String> {
    let from = utf16_byte(base, range.start).ok_or("无效选区起点")?;
    let to = utf16_byte(base, range.end).ok_or("无效选区终点")?;
    if from > to || base.get(from..to) != Some(range.text.as_str()) {
        return Err("选区与基准版本不一致".into());
    }
    let changes = edits(base, current, 0);
    let mut a = map_position(from, &changes, true).min(current.len());
    let mut b = map_position(to, &changes, false).min(current.len());
    if b < a || from == to {
        b = a;
    }
    let overlap = changes.iter().any(|e| {
        if e.start == e.end {
            e.start > from && e.start < to
        } else {
            e.start < to && e.end > from
        }
    });
    let mut state = if !overlap {
        if a == from {
            "exact"
        } else {
            "moved"
        }
    } else {
        "changed"
    };
    if overlap && !range.text.is_empty() && base.match_indices(&range.text).take(2).count() == 1 {
        let matches: Vec<_> = current
            .match_indices(&range.text)
            .map(|(p, _)| p)
            .take(2)
            .collect();
        if matches.len() == 1 {
            a = matches[0];
            b = a + range.text.len();
            state = "moved";
        }
    }
    if a == b {
        state = "deleted";
    }
    if !current.is_char_boundary(a) || !current.is_char_boundary(b) {
        return Err("无法可靠定位 Unicode 选区".into());
    }
    Ok(LocatedRange {
        start: current[..a].encode_utf16().count(),
        end: current[..b].encode_utf16().count(),
        text: current[a..b].into(),
        state: state.into(),
        line: current[..a].bytes().filter(|b| *b == b'\n').count() + 1,
        end_line: current[..b].bytes().filter(|b| *b == b'\n').count() + 1,
    })
}
#[cfg(test)]
mod anchor_tests {
    use super::*;
    #[test]
    fn reanchors_after_edits_above_and_inside() {
        let r = AnchorRange {
            start: 2,
            end: 4,
            text: "乙段".into(),
        };
        let b = "甲\n乙段\n丙";
        let a = locate_range(b, "开头\n甲\n乙段\n丙", &r).unwrap();
        assert_eq!(a.line, 3);
        assert_eq!(a.text, "乙段");
        let a = locate_range(b, "甲\n新段\n丙", &r).unwrap();
        assert_eq!(a.text, "新段");
        assert_eq!(a.state, "changed");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    async fn fixture(text: &str) -> (tempfile::TempDir, String, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("main.tex");
        fs::write(&file, text).await.unwrap();
        (dir, root, file)
    }
    #[tokio::test]
    async fn independent_agent_and_editor_edits_survive() {
        let (_d, p, f) = fixture("甲段\n乙段").await;
        fs::write(&f, "甲改段\n乙段").await.unwrap();
        let saved = save(
            &p,
            "main.tex",
            "甲段\n乙段",
            "甲段\n乙新段",
            "agent:codex:test",
            Some("note".into()),
        )
        .await
        .unwrap();
        assert_eq!(saved.status, "saved");
        assert_eq!(fs::read_to_string(&f).await.unwrap(), "甲改段\n乙新段");
        let saved = save(
            &p,
            "main.tex",
            "甲段\n乙段",
            "甲段\n乙新段",
            "agent:codex:test",
            Some("note".into()),
        )
        .await
        .unwrap();
        assert_eq!(saved.status, "saved");
        assert_eq!(saved.content, "甲改段\n乙新段");
    }
    #[tokio::test]
    async fn conflict_review_rebases_new_changes_and_never_replays_rejected_proposal() {
        let (_d, p, f) = fixture("ours\n乙段").await;
        let conflict = save(
            &p,
            "main.tex",
            "base\n乙段",
            "theirs\n乙段",
            "agent:codex:test",
            Some("note".into()),
        )
        .await
        .unwrap()
        .conflict
        .unwrap();
        assert_eq!(fs::read_to_string(&f).await.unwrap(), "ours\n乙段");
        assert_eq!(list_document_conflicts(p.clone()).await.unwrap().len(), 1);
        fs::write(&f, "ours\n乙新段").await.unwrap();
        let saved = resolve_conflict(&p, &conflict.id, &conflict.revision, "ours\n乙段")
            .await
            .unwrap();
        assert_eq!(saved.content, "ours\n乙新段");
        assert!(saved.version_error.is_none());
        assert!(list_document_conflicts(p.clone()).await.unwrap().is_empty());
        assert_eq!(
            save(
                &p,
                "main.tex",
                "base\n乙段",
                "theirs\n乙段",
                "agent:codex:test",
                Some("note".into())
            )
            .await
            .unwrap()
            .status,
            "reviewed"
        );
    }
    #[tokio::test]
    async fn late_overlap_supersedes_original_review() {
        let (_d, p, f) = fixture("ours").await;
        let old = save(
            &p,
            "main.tex",
            "base",
            "theirs",
            "agent:codex:test",
            Some("note".into()),
        )
        .await
        .unwrap()
        .conflict
        .unwrap();
        fs::write(&f, "newer").await.unwrap();
        let r = resolve_conflict(&p, &old.id, &old.revision, "chosen")
            .await
            .unwrap();
        assert_eq!(r.status, "conflict");
        let next = r.conflict.unwrap();
        assert_ne!(next.id, old.id);
        let pending = list_document_conflicts(p.clone()).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, next.id);
        assert_eq!(
            save(
                &p,
                "main.tex",
                "base",
                "theirs",
                "agent:codex:test",
                Some("note".into())
            )
            .await
            .unwrap()
            .status,
            "reviewed"
        );
    }
    #[test]
    fn deleted_duplicate_does_not_jump_to_another_occurrence() {
        let r = AnchorRange {
            start: 0,
            end: 2,
            text: "甲段".into(),
        };
        let location = locate_range("甲段\n乙段\n甲段", "乙段\n甲段", &r).unwrap();
        assert_eq!(location.state, "deleted");
    }
    #[test]
    fn partial_identifier_anchor_covers_replacement_and_deleted_stays_a_point() {
        let r = AnchorRange {
            start: 1,
            end: 2,
            text: "a".into(),
        };
        let located = locate_range("cat", "new", &r).unwrap();
        assert_eq!(located.text, "new");
        let r = AnchorRange {
            start: 1,
            end: 1,
            text: "".into(),
        };
        assert_eq!(locate_range("cat", "new", &r).unwrap().text, "");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_revision() {
        let (d, p, _) = fixture("base").await;
        let rev = snapshot(&p, "main.tex", "base").await.unwrap();
        let path = d
            .path()
            .join(".writer/revisions")
            .join(format!("{}.json", rev.id));
        let external = d.path().join("outside.json");
        fs::rename(&path, &external).await.unwrap();
        std::os::unix::fs::symlink(&external, &path).unwrap();
        assert!(revision(&p, &rev.id, "main.tex").await.is_err());
    }
}
