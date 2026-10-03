use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tokio::sync::Mutex;
static CONFIG_LOCK: Mutex<()> = Mutex::const_new(());
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildTarget {
    pub id: String,
    pub name: String,
    pub main_file: String,
    pub engine: String,
    pub work_dir: String,
    pub output_dir: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub version: u32,
    pub active_target: Option<String>,
    pub targets: Vec<BuildTarget>,
}
pub fn relative(path: &str, allow_dot: bool) -> Result<PathBuf, String> {
    if allow_dot && path == "." {
        return Ok(PathBuf::from("."));
    }
    if path.is_empty()
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(|c| c.is_control())
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("必须使用项目内的相对路径：{path}"));
    }
    Ok(PathBuf::from(path))
}
pub fn validate(config: &ProjectConfig) -> Result<(), String> {
    if config.version != 1 || config.targets.len() > 64 {
        return Err("不支持的编译配置版本或目标过多".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut outputs = std::collections::HashSet::new();
    for target in &config.targets {
        if target.id.is_empty()
            || target.id.len() > 80
            || !target
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || !ids.insert(&target.id)
        {
            return Err("编译目标 ID 无效或重复".into());
        }
        if target.name.trim().is_empty() || target.name.len() > 200 {
            return Err("请填写编译目标名称".into());
        }
        relative(&target.main_file, false)?;
        relative(&target.work_dir, true)?;
        relative(&target.output_dir, true)?;
        let stem = Path::new(&target.main_file)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        let pdf = format!("{}/{}.pdf", target.output_dir, stem).to_lowercase();
        if !outputs.insert(pdf.clone()) {
            return Err(format!(
                "多个目标写入同一个 PDF：{pdf}，请设置不同输出目录。"
            ));
        }

        if !target.main_file.to_lowercase().ends_with(".tex")
            || ![
                "auto", "pdflatex", "xelatex", "lualatex", "latexmk", "tectonic",
            ]
            .contains(&target.engine.as_str())
        {
            return Err("主文件或 LaTeX 引擎无效".into());
        }
    }
    if config
        .active_target
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("当前编译目标不存在".into());
    }
    Ok(())
}
pub fn make_target(path: &str) -> BuildTarget {
    let hash = path.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    let parent = Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(".".into());
    BuildTarget {
        id: format!("target-{hash:x}"),
        name: path.trim_end_matches(".tex").into(),
        main_file: path.into(),
        engine: "auto".into(),
        work_dir: parent.clone(),
        output_dir: parent,
    }
}
pub fn without_comments(text: &str) -> String {
    text.lines()
        .map(|line| {
            let mut escaped = false;
            for (i, c) in line.char_indices() {
                if c == '%' && !escaped {
                    return &line[..i];
                }
                if c == '\\' {
                    escaped = !escaped
                } else {
                    escaped = false
                }
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}
#[tauri::command]
pub async fn latex_scan_targets(directory: String) -> Result<Vec<BuildTarget>, String> {
    let root = super::annotations::root(&directory).await?;
    let files = tokio::task::spawn_blocking(move || {
        walkdir::WalkDir::new(&root)
            .max_depth(10)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0
                    || !entry.file_name().to_string_lossy().starts_with('.')
                        && !matches!(
                            entry.file_name().to_str(),
                            Some("node_modules" | "target" | "build" | "dist" | "drafts")
                        )
            })
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("tex"))
            })
            .map(|entry| (root.clone(), entry.into_path()))
            .take(500)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut targets = vec![];
    for (root, path) in files {
        if tokio::fs::metadata(&path)
            .await
            .map_err(|e| e.to_string())?
            .len()
            > 2_000_000
        {
            continue;
        }
        if let Ok(text) = tokio::fs::read_to_string(&path).await {
            let text = without_comments(&text);
            if text.contains("\\documentclass") || text.contains("\\begin{document}") {
                let relative = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                targets.push(make_target(&relative));
            }
        }
    }
    targets.sort_by(|a, b| {
        (
            a.main_file != "main.tex",
            a.main_file.matches('/').count(),
            &a.main_file,
        )
            .cmp(&(
                b.main_file != "main.tex",
                b.main_file.matches('/').count(),
                &b.main_file,
            ))
    });
    Ok(targets)
}
pub async fn writable_dir(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = relative(path, true)?;
    let target = root.join(relative);
    let mut ancestor = target.clone();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("无效路径")?.into();
    }
    if !tokio::fs::canonicalize(&ancestor)
        .await
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("目录链接指向项目外部".into());
    }
    tokio::fs::create_dir_all(&target)
        .await
        .map_err(|e| e.to_string())?;
    let canonical = tokio::fs::canonicalize(target)
        .await
        .map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("目录不属于项目".into());
    }
    Ok(canonical)
}
async fn config_path(directory: &str) -> Result<PathBuf, String> {
    let root = super::annotations::root(directory).await?;
    let path = writable_dir(&root, ".writer").await?.join("latex.json");
    if path.exists()
        && !tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| e.to_string())?
            .starts_with(root)
    {
        return Err("编译配置链接指向项目外".into());
    }
    Ok(path)
}
async fn save(directory: &str, config: &ProjectConfig) -> Result<(), String> {
    validate(config)?;
    let path = config_path(directory).await?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(
        &temp,
        serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, path)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn latex_project_load(
    directory: String,
    legacy_main_file: Option<String>,
) -> Result<ProjectConfig, String> {
    let _guard = CONFIG_LOCK.lock().await;
    let path = config_path(&directory).await?;
    if path.exists() {
        let config: ProjectConfig =
            serde_json::from_slice(&tokio::fs::read(path).await.map_err(|e| e.to_string())?)
                .map_err(|e| format!("编译配置读取失败，原文件已保留：{e}"))?;
        validate(&config)?;
        return Ok(config);
    }
    let mut targets = latex_scan_targets(directory.clone()).await?;
    if let Some(legacy) = legacy_main_file
        .clone()
        .filter(|p| relative(p, false).is_ok())
    {
        let root = super::annotations::root(&directory).await?;
        if root.join(&legacy).is_file() && !targets.iter().any(|t| t.main_file == legacy) {
            targets.push(make_target(&legacy));
        }
    }
    let active = targets
        .iter()
        .find(|t| Some(&t.main_file) == legacy_main_file.as_ref())
        .or(targets.first())
        .map(|t| t.id.clone());
    let config = ProjectConfig {
        version: 1,
        active_target: active,
        targets,
    };
    save(&directory, &config).await?;
    Ok(config)
}
#[tauri::command]
pub async fn latex_project_save(directory: String, config: ProjectConfig) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().await;
    save(&directory, &config).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn detects_two_languages_and_nested_entrypoints_ignoring_comments() {
        let d = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(d.path().join("en")).await.unwrap();
        for (file, text) in [
            ("main_zh.tex", "\\documentclass{ctexart}"),
            ("en/main.tex", "\\documentclass{article}"),
            ("fragment.tex", "% \\documentclass{article}\nOnly a section"),
        ] {
            tokio::fs::write(d.path().join(file), text).await.unwrap();
        }
        let targets = latex_scan_targets(d.path().to_str().unwrap().into())
            .await
            .unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[1].work_dir, "en");
        assert_ne!(targets[0].id, targets[1].id);
    }
    #[tokio::test]
    async fn settings_move_with_project_without_absolute_machine_paths() {
        let d = tempfile::tempdir().unwrap();
        tokio::fs::write(d.path().join("paper.tex"), "\\begin{document}")
            .await
            .unwrap();
        let directory = d.path().to_str().unwrap().to_string();
        let mut cfg = latex_project_load(directory.clone(), None).await.unwrap();
        cfg.targets[0].engine = "tectonic".into();
        cfg.targets[0].output_dir = "build/en".into();
        latex_project_save(directory.clone(), cfg.clone())
            .await
            .unwrap();
        assert_eq!(latex_project_load(directory, None).await.unwrap(), cfg);
        cfg.targets[0].main_file = "../outside.tex".into();
        assert!(validate(&cfg).is_err());
    }
}
