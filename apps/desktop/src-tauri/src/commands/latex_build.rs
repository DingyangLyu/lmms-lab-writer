use super::{
    latex::{BuildSlot, CompileOutputEvent, CompilerInfo, LaTeXCompilationState},
    latex_project::{BuildTarget, ProjectConfig},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc};
use tauri::{AppHandle, Emitter, State, Window};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::Mutex,
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub success: bool,
    pub pdf_path: Option<String>,
    pub pdf_relative: Option<String>,
    pub engine: String,
    pub compiler_path: String,
    pub output: String,
    pub error: Option<String>,
    /// Tail of a failed run's TeX log; the staging directory holding it is removed afterwards.
    pub log: Option<String>,
}
/// Failed-build logs larger than this keep only their end, where TeX reports the stop.
const FAILED_LOG_LIMIT: usize = 64 * 1024;
fn log_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut start = text.len().saturating_sub(FAILED_LOG_LIMIT);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}
pub async fn resolve(
    name: &str,
    overrides: &HashMap<String, String>,
) -> Result<CompilerInfo, String> {
    if let Some(path) = overrides.get(name).filter(|s| !s.trim().is_empty()) {
        if let Ok(Ok(output)) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            super::util::command(path)
                .arg("--version")
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            if output.status.success() {
                return Ok(CompilerInfo {
                    name: name.into(),
                    path: Some(path.clone()),
                    available: true,
                    version: Some(
                        String::from_utf8_lossy(&output.stdout)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .into(),
                    ),
                });
            }
        }
    }
    let info = super::latex::find_compiler(name).await;
    if info.available {
        Ok(info)
    } else {
        Err(trf!("未找到可运行的 {name}。请安装 LaTeX 环境，或在‘编译目标’中设置本机路径。", "Could not find a runnable {name}. Install a LaTeX distribution, or set its path under Build targets."
        ))
    }
}
// Which engine a project needs when its target says "auto": the same rules, step for step,
// as packages/writing/src/engine.ts on the web; packages/writing/fixtures/engine-cases.json is
// checked on both sides, so change them together.
const MAGIC: [&str; 5] = ["pdflatex", "xelatex", "lualatex", "tectonic", "latexmk"];
const XE_PACKAGES: [&str; 7] = [
    "ctex",
    "xeCJK",
    "fontspec",
    "polyglossia",
    "unicode-math",
    "xltxtra",
    "xunicode",
];
const XE_CLASSES: [&str; 4] = ["ctexart", "ctexbook", "ctexrep", "ctexbeamer"];
/// Files followed through \input and \include, at most.
const MAX_FILES: usize = 100;
/// `% !TEX program = xelatex` (or TS-program) in the first 30 lines.
fn magic_engine(text: &str) -> Option<String> {
    text.lines().take(30).find_map(|line| {
        let lower = line.to_lowercase();
        if !lower.trim_start().starts_with('%')
            || !lower.contains("!tex")
            || !lower.contains("program")
        {
            return None;
        }
        let engine = lower.split('=').nth(1)?.trim();
        MAGIC.contains(&engine).then(|| engine.into())
    })
}
/// The braced arguments of `\command[options]{…}` (not of longer command names).
fn arguments(source: &str, command: &str) -> Vec<String> {
    let mut found = vec![];
    let mut from = 0;
    while let Some(offset) = source[from..].find(command) {
        let at = from + offset;
        let mut i = at + command.len();
        let skip = |i: &mut usize| {
            while let Some(c) = source[*i..].chars().next().filter(|c| c.is_whitespace()) {
                *i += c.len_utf8();
            }
        };
        if !source[i..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '@')
        {
            skip(&mut i);
            if source[i..].starts_with('[') {
                i = source[i..]
                    .find(']')
                    .map_or(source.len(), |close| i + close + 1);
                skip(&mut i);
            }
            if source[i..].starts_with('{') {
                if let Some(close) = source[i..].find('}') {
                    found.push(source[i + 1..i + close].to_string());
                }
            }
        }
        from = at + command.len();
    }
    found
}
fn names(source: &str, command: &str) -> Vec<String> {
    arguments(source, command)
        .iter()
        .flat_map(|list| list.split(',').map(|name| name.trim().to_string()))
        .collect()
}
/// 3 LuaLaTeX, 2 XeLaTeX for its packages, 1 XeLaTeX for CJK text, 0 anything.
fn engine_need(text: &str) -> u8 {
    let source = super::latex_project::without_comments(text);
    let mut packages = names(&source, "\\usepackage");
    packages.extend(names(&source, "\\RequirePackage"));
    let classes = names(&source, "\\documentclass");
    if packages.iter().any(|p| p.starts_with("luatexja"))
        || classes.iter().any(|c| c.starts_with("ltj"))
    {
        return 3;
    }
    if packages.iter().any(|p| XE_PACKAGES.contains(&p.as_str()))
        || classes.iter().any(|c| XE_CLASSES.contains(&c.as_str()))
    {
        return 2;
    }
    let cjk = source.chars().any(
        |c| matches!(c,'\u{3040}'..='\u{30ff}'|'\u{3400}'..='\u{9fff}'|'\u{f900}'..='\u{faff}'),
    );
    u8::from(cjk)
}
/// The most any of `entry` and the files it inputs (inside `root`, relative to `work`) needs.
async fn needed_engine(root: &Path, work: &Path, entry: &Path) -> u8 {
    let root = tokio::fs::canonicalize(root)
        .await
        .unwrap_or_else(|_| root.to_path_buf());
    let mut need = 0;
    let mut pending = vec![entry.to_path_buf()];
    let mut visited = std::collections::HashSet::new();
    while visited.len() < MAX_FILES {
        let Some(path) = pending.pop() else {
            break;
        };
        let Ok(path) = tokio::fs::canonicalize(path).await else {
            continue;
        };
        if !path.starts_with(&root) || visited.contains(&path) {
            continue;
        }
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        visited.insert(path);
        need = need.max(engine_need(&text));
        let source = super::latex_project::without_comments(&text);
        let mut inputs = arguments(&source, "\\input");
        inputs.extend(arguments(&source, "\\include"));
        for name in inputs {
            let name = name.trim();
            // Where TeX finds it: name.tex, then name, each in the working folder and then the
            // project's top folder (the search path the build gives TeX).
            let names = if name.ends_with(".tex") {
                vec![name.to_string()]
            } else {
                vec![format!("{name}.tex"), name.to_string()]
            };
            for candidate in names.iter().flat_map(|n| [work.join(n), root.join(n)]) {
                if tokio::fs::metadata(&candidate)
                    .await
                    .is_ok_and(|m| m.is_file())
                {
                    pending.push(candidate);
                    break;
                }
            }
        }
    }
    need
}
#[derive(Debug)]
struct Plan {
    engine: String,
    program: String,
    args: Vec<String>,
    direct: bool,
}
async fn plan(
    target: &BuildTarget,
    root: &Path,
    work: &Path,
    entry: &Path,
    out: &Path,
    overrides: &HashMap<String, String>,
) -> Result<Plan, String> {
    let text = tokio::fs::read_to_string(entry)
        .await
        .map_err(|e| e.to_string())?;
    let need = needed_engine(root, work, entry).await;
    let requested = if target.engine == "auto" {
        magic_engine(&text).unwrap_or("auto".into())
    } else {
        target.engine.clone()
    };
    let candidates: Vec<&str> = if requested == "auto" || requested == "latexmk" {
        match need {
            3 => vec!["lualatex"],
            1 | 2 => vec!["xelatex", "lualatex", "tectonic"],
            _ => vec!["pdflatex", "xelatex", "lualatex", "tectonic"],
        }
    } else {
        vec![&requested]
    };
    let mut selected = None;
    for candidate in candidates {
        if let Ok(info) = resolve(candidate, overrides).await {
            selected = Some((candidate.to_string(), info.path.unwrap()));
            break;
        }
    }
    let (engine, path) = selected.ok_or_else(|| {
        if need == 3 {
            tr!(
                "这份文稿使用 luatexja，需要 LuaLaTeX，当前未检测到。",
                "This document uses luatexja and needs LuaLaTeX, which was not found."
            )
            .to_string()
        } else if need > 0 {
            tr!(
                "中文／Unicode 文稿需要 XeLaTeX、LuaLaTeX 或 Tectonic，当前未检测到。",
                "Chinese/Unicode documents need XeLaTeX, LuaLaTeX or Tectonic, and none was found."
            )
            .to_string()
        } else {
            trf!(
                "无法找到编译器：{requested}",
                "Could not find the compiler: {requested}"
            )
        }
    })?;
    let input = entry.to_string_lossy().into_owned();
    let output = out.to_string_lossy().into_owned();
    if engine == "tectonic" {
        return Ok(Plan {
            engine,
            program: path,
            args: vec![
                "--synctex".into(),
                "--keep-logs".into(),
                "--keep-intermediates".into(),
                "--untrusted".into(),
                "--outdir".into(),
                output,
                input,
            ],
            direct: false,
        });
    }
    if let Ok(latexmk) = resolve("latexmk", overrides).await {
        if overrides.get(&engine).is_none_or(|custom| custom != &path) {
            return Ok(Plan {
                engine: engine.clone(),
                program: latexmk.path.unwrap(),
                args: vec![
                    "-norc".into(),
                    match engine.as_str() {
                        "xelatex" => "-xelatex",
                        "lualatex" => "-lualatex",
                        _ => "-pdf",
                    }
                    .into(),
                    "-interaction=nonstopmode".into(),
                    "-file-line-error".into(),
                    "-synctex=1".into(),
                    "-no-shell-escape".into(),
                    format!("-outdir={output}"),
                    input,
                ],
                direct: false,
            });
        }
    }
    Ok(Plan {
        engine,
        program: path,
        args: vec![
            "-interaction=nonstopmode".into(),
            "-file-line-error".into(),
            "-synctex=1".into(),
            "-no-shell-escape".into(),
            format!("-output-directory={output}"),
            input,
        ],
        direct: true,
    })
}
async fn run_program(
    app: Option<&AppHandle>,
    state: &BuildSlot,
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
) -> Result<(bool, String), String> {
    if let Some(app) = app {
        let _ = app.emit(
            "latex-compile-output",
            CompileOutputEvent {
                line: format!("{} {}", program, args.join(" ")),
                is_error: false,
                is_warning: false,
            },
        );
    }
    let mut command = super::util::command(program);
    command
        .args(args)
        .current_dir(cwd)
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| {
        trf!(
            "无法启动编译器 {program}：{e}",
            "Could not start the compiler {program}: {e}"
        )
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.current_process.lock().await = Some(child);
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut readers = vec![];
    macro_rules! stream {
        ($pipe:expr) => {
            if let Some(pipe) = $pipe {
                let app = app.cloned();
                let tail = tail.clone();
                readers.push(tokio::spawn(async move {
                    let mut lines = BufReader::new(pipe).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let line: String = line.chars().take(8192).collect();
                        let lower = line.to_lowercase();
                        if let Some(app) = &app {
                            let _ = app.emit(
                                "latex-compile-output",
                                CompileOutputEvent {
                                    is_error: lower.contains("error") || line.starts_with('!'),
                                    is_warning: lower.contains("warning"),
                                    line: line.clone(),
                                },
                            );
                        }
                        let mut tail = tail.lock().await;
                        tail.push(line);
                        if tail.len() > 120 {
                            tail.remove(0);
                        }
                    }
                }));
            }
        };
    }
    stream!(stdout);
    stream!(stderr);
    let start = std::time::Instant::now();
    let status = loop {
        {
            let mut guard = state.current_process.lock().await;
            let Some(child) = guard.as_mut() else {
                for reader in readers {
                    reader.abort()
                }
                return Err(tr!("编译已取消", "The build was cancelled").into());
            };
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                guard.take();
                break status.success();
            }
            if start.elapsed() > std::time::Duration::from_secs(600) {
                let _ = child.kill().await;
                guard.take();
                for reader in readers {
                    reader.abort()
                }
                return Err(tr!(
                    "编译超过 10 分钟，已停止；原 PDF 保留。",
                    "The build ran over 10 minutes and was stopped; the previous PDF was kept."
                )
                .into());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    };
    for mut reader in readers {
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut reader)
            .await
            .is_err()
        {
            reader.abort();
        }
    }
    let output = tail.lock().await.join("\n");
    Ok((status, output))
}
#[tauri::command]
pub async fn latex_build_target(
    app: AppHandle,
    window: Window,
    state: State<'_, LaTeXCompilationState>,
    directory: String,
    target: BuildTarget,
    compiler_overrides: Option<HashMap<String, String>>,
) -> Result<BuildResult, String> {
    let slot = state.slot(window.label());
    build(Some(&app), &slot, directory, target, compiler_overrides).await
}
async fn build(
    app: Option<&AppHandle>,
    state: &BuildSlot,
    directory: String,
    target: BuildTarget,
    compiler_overrides: Option<HashMap<String, String>>,
) -> Result<BuildResult, String> {
    let _job = state.build_lock.try_lock().map_err(|_| {
        tr!(
            "另一个编译正在进行，请完成或停止后再编译",
            "Another build is running; let it finish or stop it first"
        )
    })?;
    super::latex_project::validate(&ProjectConfig {
        version: 1,
        active_target: Some(target.id.clone()),
        targets: vec![target.clone()],
    })?;
    let root = super::annotations::root(&directory).await?;
    let entry = super::annotations::project_file(&root, &target.main_file).await?;
    let work =
        tokio::fs::canonicalize(root.join(super::latex_project::relative(&target.work_dir, true)?))
            .await
            .map_err(|e| {
                trf!(
                    "工作目录不可用：{e}",
                    "The working folder is unavailable: {e}"
                )
            })?;
    if !work.starts_with(&root) || !work.is_dir() {
        return Err(tr!(
            "工作目录不属于当前项目",
            "The working folder is not part of the current project"
        )
        .into());
    }
    let output_dir = super::latex_project::writable_dir(&root, &target.output_dir).await?;
    let stage = super::latex_project::writable_dir(
        &root,
        &format!(".writer/build-cache/{}-{}", target.id, uuid::Uuid::new_v4()),
    )
    .await?;
    let overrides = compiler_overrides.unwrap_or_default();
    let plan = match plan(&target, &root, &work, &entry, &stage, &overrides).await {
        Ok(plan) => plan,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&stage).await;
            return Err(error);
        }
    };
    let mut paths = vec![];
    if let Some(parent) = Path::new(&plan.program).parent() {
        paths.push(parent.to_path_buf());
    }
    if let Ok(engine) = resolve(&plan.engine, &overrides).await {
        if let Some(path) = engine.path.as_deref().and_then(|p| Path::new(p).parent()) {
            paths.push(path.to_path_buf());
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    let path = std::env::join_paths(paths)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let search = format!("{}{}{}{}", work.display(), sep, root.display(), sep);
    let env = vec![
        ("PATH".into(), path),
        ("TEXINPUTS".into(), search.clone()),
        ("BIBINPUTS".into(), search.clone()),
        ("BSTINPUTS".into(), search),
    ];
    let stem = entry
        .file_stem()
        .ok_or(tr!("无效主文件名", "Invalid main file name"))?
        .to_string_lossy()
        .into_owned();
    let outcome = async {
        let (mut success, mut log) =
            run_program(app, state, &plan.program, &plan.args, &work, &env).await?;
        if success && plan.direct {
            let aux = stage.join(format!("{stem}.aux"));
            let bcf = stage.join(format!("{stem}.bcf"));
            let aux_text = tokio::fs::read_to_string(aux).await.unwrap_or_default();
            let bib = if bcf.exists() {
                Some("biber")
            } else if aux_text.contains("\\bibdata") {
                Some("bibtex")
            } else {
                None
            };
            if let Some(bib) = bib {
                let info = resolve(bib, &overrides).await?;
                let (ok, output) = run_program(
                    app,
                    state,
                    info.path.as_deref().unwrap(),
                    std::slice::from_ref(&stem),
                    &stage,
                    &env,
                )
                .await?;
                success = ok;
                log.push_str(&format!("\n{output}"));
            }
            for _ in 0..2 {
                if !success {
                    break;
                }
                let (ok, output) =
                    run_program(app, state, &plan.program, &plan.args, &work, &env).await?;
                success = ok;
                log.push_str(&format!("\n{output}"));
            }
        }
        let pdf = stage.join(format!("{stem}.pdf"));
        if !success || !pdf.is_file() {
            let tex_log = tokio::fs::read(stage.join(format!("{stem}.log")))
                .await
                .ok();
            return Ok(BuildResult {
                success: false,
                pdf_path: None,
                pdf_relative: None,
                engine: plan.engine.clone(),
                compiler_path: plan.program.clone(),
                output: log,
                error: Some(tr!("编译失败或没有生成新 PDF；原 PDF 未替换。", "The build failed or produced no new PDF; the previous PDF was not replaced.").into()),
                log: tex_log.as_deref().map(log_tail),
            });
        }
        // Only publish outputs after a successful run. Never mistake yesterday's PDF for a fresh build.
        let final_pdf = output_dir.join(format!("{stem}.pdf"));
        let mut entries = tokio::fs::read_dir(&stage)
            .await
            .map_err(|e| e.to_string())?;
        let mut publications = vec![];
        const SUFFIXES: &[&str] = &[
            "pdf",
            "synctex.gz",
            "log",
            "aux",
            "bbl",
            "bcf",
            "blg",
            "run.xml",
            "toc",
            "out",
            "fls",
            "fdb_latexmk",
            "xdv",
            "lof",
            "lot",
        ];
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if !entry
                .file_type()
                .await
                .map_err(|e| e.to_string())?
                .is_file()
                || !SUFFIXES
                    .iter()
                    .any(|suffix| name_text == format!("{stem}.{suffix}"))
            {
                continue;
            }
            let target = output_dir.join(&name);
            if target.is_symlink() {
                return Err(trf!("输出目标不能是符号链接：{}", "The output target must not be a symbolic link: {}", target.display()));
            }
            publications.push((entry.path(), target));
        }
        // Publish the visible PDF last, after its log and navigation metadata.
        publications.sort_by_key(|(_, target)| target == &final_pdf);
        for (from, to) in publications {
            tokio::fs::rename(from, to)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(BuildResult {
            success: true,
            pdf_relative: Some(
                final_pdf
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            ),
            pdf_path: Some(final_pdf.to_string_lossy().into()),
            engine: plan.engine.clone(),
            compiler_path: plan.program.clone(),
            output: log,
            error: None,
            log: None,
        })
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&stage).await;
    outcome
}
#[cfg(test)]
mod tests {
    use super::*;
    /// The web chooses engines with packages/writing; its cases must come out the same here.
    #[tokio::test]
    async fn chooses_engines_as_the_web_does() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            main: String,
            base: String,
            files: HashMap<String, String>,
            engine: String,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../../../packages/writing/fixtures/engine-cases.json"
        ))
        .unwrap();
        for c in cases {
            let d = tempfile::tempdir().unwrap();
            // Inputs that leave the project must not be read even when the file exists.
            let root = d.path().join("project");
            tokio::fs::write(d.path().join("secret.tex"), "\\usepackage{fontspec}")
                .await
                .unwrap();
            for (path, text) in &c.files {
                let file = root.join(path);
                tokio::fs::create_dir_all(file.parent().unwrap())
                    .await
                    .unwrap();
                tokio::fs::write(file, text).await.unwrap();
            }
            let entry = root.join(&c.main);
            let text = tokio::fs::read_to_string(&entry).await.unwrap();
            let engine = match magic_engine(&text) {
                Some(engine) => engine,
                None => match needed_engine(&root, &root.join(&c.base), &entry).await {
                    3 => "lualatex",
                    1 | 2 => "xelatex",
                    _ => "pdflatex",
                }
                .into(),
            };
            assert_eq!(engine, c.engine, "{}", c.name);
        }
    }
    #[test]
    fn failed_log_keeps_the_end_on_a_char_boundary() {
        let mut log = "中".repeat(FAILED_LOG_LIMIT).into_bytes();
        log.extend_from_slice(b"\n! Undefined control sequence.");
        let tail = log_tail(&log);
        assert!(tail.len() <= FAILED_LOG_LIMIT);
        assert!(tail.ends_with("! Undefined control sequence."));
        assert_eq!(log_tail(b"short"), "short");
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires locally installed Tectonic and its package bundle"]
    async fn compiles_bilingual_nested_mains_and_keeps_the_last_pdf_on_failure() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().to_string_lossy().into_owned();
        for subdir in ["en", "zh"] {
            tokio::fs::create_dir(temp.path().join(subdir))
                .await
                .unwrap();
        }
        tokio::fs::write(
            temp.path().join("en/main.tex"),
            "\\documentclass{article}\n\\begin{document}English version.\\end{document}\n",
        )
        .await
        .unwrap();
        tokio::fs::write(temp.path().join("zh/main.tex"),"\\documentclass[fontset=fandol]{ctexart}\n\\begin{document}中文版本测试。\\end{document}\n").await.unwrap();
        let state = BuildSlot::default();
        for entry in ["en/main.tex", "zh/main.tex"] {
            let mut target = super::super::latex_project::make_target(entry);
            target.engine = "tectonic".into();
            target.output_dir = format!("output/{}", entry.split('/').next().unwrap());
            let result = build(None, &state, directory.clone(), target, None)
                .await
                .unwrap();
            assert!(result.success, "{}: {}", entry, result.output);
            assert_eq!(
                result.pdf_relative,
                Some(format!(
                    "output/{}/main.pdf",
                    entry.split('/').next().unwrap()
                ))
            );
        }
        let en = temp.path().join("output/en/main.pdf");
        let zh = temp.path().join("output/zh/main.pdf");
        assert!(en.exists() && zh.exists());
        assert!(temp.path().join("output/zh/main.synctex.gz").exists());
        let previous = tokio::fs::read(&en).await.unwrap();
        tokio::fs::write(
            temp.path().join("en/main.tex"),
            "\\documentclass{article}\n\\begin{document}\\UndefinedWriterCommand\\end{document}",
        )
        .await
        .unwrap();
        let mut target = super::super::latex_project::make_target("en/main.tex");
        target.engine = "tectonic".into();
        target.output_dir = "output/en".into();
        let failed = build(None, &state, directory, target, None).await.unwrap();
        assert!(!failed.success);
        assert!(failed.pdf_path.is_none());
        assert!(failed
            .log
            .is_some_and(|log| log.contains("UndefinedWriterCommand")));
        assert_eq!(tokio::fs::read(en).await.unwrap(), previous);
    }
}

#[cfg(test)]
mod bibliography_integration {
    use super::*;
    #[tokio::test]
    #[ignore = "requires a local TeX distribution and bibliography tools"]
    async fn auto_engine_builds_nested_bibliography_into_the_selected_output_directory() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("paper");
        tokio::fs::create_dir(&source).await.unwrap();
        tokio::fs::write(source.join("main.tex"),"\\documentclass{article}\n\\begin{document}Test citation \\cite{test}.\\bibliographystyle{plain}\\bibliography{refs}\\end{document}\n").await.unwrap();
        tokio::fs::write(source.join("refs.bib"),"@article{test,author={Example, A.},title={A Verified Test},journal={Testing},year={2026}}\n").await.unwrap();
        let mut target = super::super::latex_project::make_target("paper/main.tex");
        target.output_dir = "build/paper".into();
        let result = build(
            None,
            &BuildSlot::default(),
            temp.path().to_string_lossy().into(),
            target,
            None,
        )
        .await
        .unwrap();
        assert!(result.success, "{}", result.output);
        let bibliography = tokio::fs::read_to_string(temp.path().join("build/paper/main.bbl"))
            .await
            .unwrap();
        assert!(bibliography.contains("Verified Test") || bibliography.contains("verified test"));
        assert!(!temp.path().join("main.pdf").exists());
    }
}
