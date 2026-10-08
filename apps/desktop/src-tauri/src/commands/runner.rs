//! Runs one shared AI task leased from a collaboration server, the way the server's command-line
//! runner (`apps/collaboration/server/runner.ts`) does: a disposable copy of the task's snapshot,
//! a restricted CLI session, and the changed files returned for review. Nothing here touches
//! the user's own project folder.
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};

#[derive(Deserialize)]
pub struct JobFile {
    path: String,
    binary: bool,
    content: Option<String>,
    base64: Option<String>,
}
#[derive(Deserialize)]
pub struct Job {
    id: String,
    prompt: String,
    harness: String,
    files: Vec<JobFile>,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct Output {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct JobResult {
    files: Vec<Output>,
    result: String,
}

#[derive(Default)]
pub struct RunnerState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

/// The server's text extensions (packages/sync/src/paths.ts).
const TEXT: &[&str] = &[
    "tex", "bib", "md", "txt", "sty", "cls", "bst", "csv", "json", "py", "yml", "yaml",
];
const RETURNED_BINARY: &[&str] = &["png", "jpg", "jpeg", "svg", "pdf"];
const TIMEOUT: Duration = Duration::from_secs(600);
const LOG_LIMIT: usize = 45_000;

fn extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Same rules as the server: relative, "/"-separated, no hidden or parent segments.
fn valid(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 240
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(|c| c.is_control())
        && path
            .split('/')
            .all(|p| !p.is_empty() && !p.starts_with('.'))
}

fn tail(log: &str) -> String {
    let start = log.len().saturating_sub(LOG_LIMIT);
    let start = (start..=log.len())
        .find(|i| log.is_char_boundary(*i))
        .unwrap_or(log.len());
    log[start..].to_string()
}

struct Command {
    program: PathBuf,
    args: Vec<String>,
    env: Vec<(&'static str, String)>,
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

async fn harness(kind: &str) -> Result<Command, String> {
    Ok(match kind {
        "codex" => Command {
            program: super::codex::find_codex_binary()
                .await
                .ok_or("本机未安装 Codex")?,
            args: strings(&[
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "-c",
                "approval_policy=\"never\"",
                "-",
            ]),
            env: vec![],
        },
        "claude" => Command {
            program: super::claude::binary().await?,
            // No shell: the task can only read and edit files in its copy.
            args: strings(&[
                "-p",
                "--permission-mode",
                "acceptEdits",
                "--tools",
                "Read,Write,Edit,Glob,Grep",
                "--output-format",
                "text",
            ]),
            env: vec![],
        },
        "opencode" => Command {
            program: PathBuf::from(
                super::opencode::find_opencode()
                    .await
                    .ok_or("本机未安装 OpenCode")?,
            ),
            args: strings(&["run"]),
            env: vec![(
                "OPENCODE_PERMISSION",
                r#"{"external_directory":"deny","bash":"deny","edit":"allow","read":"allow","webfetch":"allow"}"#
                    .into(),
            )],
        },
        _ => return Err("这台电脑只执行 Codex、Claude Code 或 OpenCode 任务".into()),
    })
}

async fn write_snapshot(work: &Path, job: &Job) -> Result<HashSet<String>, String> {
    let mut withheld = HashSet::new();
    for file in &job.files {
        let name = file.path.rsplit('/').next().unwrap_or("").to_lowercase();
        // A project's agent configuration is never handed to the local CLI.
        if !valid(&file.path) || name == "opencode.json" || name == "opencode.jsonc" {
            withheld.insert(file.path.clone());
            continue;
        }
        let target = work.join(&file.path);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        let bytes = if file.binary {
            base64::engine::general_purpose::STANDARD
                .decode(file.base64.as_deref().unwrap_or(""))
                .map_err(|e| e.to_string())?
        } else {
            file.content.clone().unwrap_or_default().into_bytes()
        };
        tokio::fs::write(target, bytes)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(withheld)
}

/// Changed text and figure files, and text files the task deleted (returned empty).
pub async fn collect(
    work: &Path,
    job: &Job,
    withheld: &HashSet<String>,
) -> Result<Vec<Output>, String> {
    let before: HashMap<&str, &JobFile> = job.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut outputs = vec![];
    let mut seen = HashSet::new();
    let mut stack = vec![(work.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || ["node_modules", "build", "dist", "target"].contains(&name.as_str())
            {
                continue;
            }
            let path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let kind = entry.file_type().await.map_err(|e| e.to_string())?;
            if kind.is_symlink() || withheld.contains(&path) {
                continue;
            }
            if kind.is_dir() {
                stack.push((entry.path(), path));
                continue;
            }
            if !kind.is_file() || !valid(&path) {
                continue;
            }
            seen.insert(path.clone());
            let bytes = tokio::fs::read(entry.path())
                .await
                .map_err(|e| e.to_string())?;
            if bytes.len() > 2_000_000 {
                continue;
            }
            let old = before.get(path.as_str());
            let ext = extension(&path);
            if TEXT.contains(&ext.as_str()) {
                let content = String::from_utf8_lossy(&bytes).into_owned();
                if old.and_then(|f| f.content.as_ref()) != Some(&content) {
                    outputs.push(Output {
                        path,
                        content: Some(content),
                        base64: None,
                    });
                }
            } else if RETURNED_BINARY.contains(&ext.as_str()) {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if old.and_then(|f| f.base64.as_ref()) != Some(&encoded) {
                    outputs.push(Output {
                        path,
                        content: None,
                        base64: Some(encoded),
                    });
                }
            }
            if outputs.len() > 200 {
                return Err("任务产物过多".into());
            }
        }
    }
    for file in &job.files {
        if !file.binary && !withheld.contains(&file.path) && !seen.contains(&file.path) {
            outputs.push(Output {
                path: file.path.clone(),
                content: Some(String::new()),
                base64: None,
            });
        }
    }
    outputs.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(outputs)
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid.filter(|p| *p > 1) {
        // SAFETY: the group was created for this child with process_group(0).
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

async fn run(job: &Job, work: &Path, cancel: oneshot::Receiver<()>) -> Result<String, String> {
    run_with(harness(&job.harness).await?, job, work, cancel, TIMEOUT).await
}

async fn run_with(
    command: Command,
    job: &Job,
    work: &Path,
    cancel: oneshot::Receiver<()>,
    timeout: Duration,
) -> Result<String, String> {
    let program = command.program.to_string_lossy().into_owned();
    let mut process = super::util::command(&program);
    process
        .args(&command.args)
        .current_dir(work)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in &command.env {
        process.env(key, value);
    }
    // npm-installed CLIs start with `#!/usr/bin/env node`, which a Finder-launched app lacks.
    if let Some(directory) = super::codex::find_node_runtime_directory(&command.program).await {
        let mut paths = vec![directory];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            process.env("PATH", path);
        }
    }
    #[cfg(unix)]
    process.process_group(0);
    let mut child = process
        .spawn()
        .map_err(|e| format!("无法启动 {}：{e}", job.harness))?;
    let input = format!(
        "You are editing a disposable snapshot for Writer collaboration. Follow this user task: {}\nEdit project text files only. Do not read credentials or unrelated directories. Your changes will be returned as proposals; reviewers choose whether to apply them. Do not publish or push anything.\n",
        job.prompt
    );
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let log = Arc::new(Mutex::new(String::new()));
    let mut readers = vec![];
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let log = log.clone();
        readers.push(tokio::spawn(async move {
            let mut stream = stream;
            let mut buffer = [0u8; 8192];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let mut log = log.lock().await;
                log.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if log.len() > LOG_LIMIT * 2 {
                    *log = tail(&log);
                }
            }
        }));
    }
    let pid = child.id();
    let outcome = tokio::select! {
        status = child.wait() => status.map_err(|e| e.to_string()),
        _ = tokio::time::sleep(timeout) => Err("任务超时，已停止".into()),
        _ = cancel => Err("任务已取消".into()),
    };
    if outcome.is_err() {
        #[cfg(unix)]
        kill_group(pid);
        let _ = child.kill().await;
    }
    for reader in readers {
        let _ = reader.await;
    }
    let log = tail(&log.lock().await);
    let status = outcome?;
    if !status.success() {
        return Err(format!(
            "任务失败（{}）：{log}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(log)
}

#[tauri::command]
pub async fn runner_execute(state: State<'_, RunnerState>, job: Job) -> Result<JobResult, String> {
    let (stop, cancel) = oneshot::channel();
    state.running.lock().await.insert(job.id.clone(), stop);
    let work = std::env::temp_dir().join(format!("writer-job-{}", uuid::Uuid::new_v4()));
    let outcome = async {
        tokio::fs::create_dir_all(&work)
            .await
            .map_err(|e| e.to_string())?;
        let withheld = write_snapshot(&work, &job).await?;
        let log = run(&job, &work, cancel).await?;
        Ok(JobResult {
            files: collect(&work, &job, &withheld).await?,
            result: if log.trim().is_empty() {
                "任务完成，输出已提交审阅。".into()
            } else {
                log
            },
        })
    }
    .await;
    state.running.lock().await.remove(&job.id);
    let _ = tokio::fs::remove_dir_all(&work).await;
    outcome
}

/// Stops a running task (the server cancelled it or stopped accepting heartbeats).
#[tauri::command]
pub async fn runner_cancel(state: State<'_, RunnerState>, job: String) -> Result<(), String> {
    if let Some(stop) = state.running.lock().await.remove(&job) {
        let _ = stop.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(files: Vec<JobFile>) -> Job {
        Job {
            id: "j".into(),
            prompt: "p".into(),
            harness: "codex".into(),
            files,
        }
    }
    fn text(path: &str, content: &str) -> JobFile {
        JobFile {
            path: path.into(),
            binary: false,
            content: Some(content.into()),
            base64: None,
        }
    }

    #[tokio::test]
    async fn returns_changed_created_and_deleted_files_but_not_withheld_ones() {
        let d = tempfile::tempdir().unwrap();
        let job = job(vec![
            text("main.tex", "old"),
            text("keep.tex", "same"),
            text("gone.tex", "x"),
            text("opencode.json", "{}"),
        ]);
        let withheld = write_snapshot(d.path(), &job).await.unwrap();
        assert!(!d.path().join("opencode.json").exists());
        tokio::fs::write(d.path().join("main.tex"), "new")
            .await
            .unwrap();
        tokio::fs::remove_file(d.path().join("gone.tex"))
            .await
            .unwrap();
        tokio::fs::create_dir(d.path().join("sec")).await.unwrap();
        tokio::fs::write(d.path().join("sec/intro.tex"), "added")
            .await
            .unwrap();
        tokio::fs::write(d.path().join("notes.log"), "ignored type")
            .await
            .unwrap();
        tokio::fs::create_dir(d.path().join(".git")).await.unwrap();
        tokio::fs::write(d.path().join(".git/x.tex"), "hidden")
            .await
            .unwrap();
        let out = collect(d.path(), &job, &withheld).await.unwrap();
        let summary: Vec<_> = out
            .iter()
            .map(|o| (o.path.as_str(), o.content.as_deref()))
            .collect();
        assert_eq!(
            summary,
            [
                ("gone.tex", Some("")),
                ("main.tex", Some("new")),
                ("sec/intro.tex", Some("added"))
            ]
        );
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        Command {
            program: "/bin/sh".into(),
            args: strings(&["-c", script]),
            env: vec![],
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hands_the_task_to_the_cli_and_returns_its_edits() {
        let d = tempfile::tempdir().unwrap();
        let job = job(vec![text("main.tex", "old")]);
        let withheld = write_snapshot(d.path(), &job).await.unwrap();
        let (_stop, cancel) = oneshot::channel();
        let log = run_with(
            shell("cat > task.txt; printf new > main.tex; echo done"),
            &job,
            d.path(),
            cancel,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(log.trim(), "done");
        let out = collect(d.path(), &job, &withheld).await.unwrap();
        assert_eq!(out[0].content.as_deref(), Some("new"));
        assert!(out[1]
            .content
            .as_deref()
            .unwrap()
            .contains("Follow this user task: p"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_stops_the_cli_and_its_children() {
        let d = tempfile::tempdir().unwrap();
        let job = job(vec![]);
        let (stop, cancel) = oneshot::channel();
        let started = std::time::Instant::now();
        let running = tokio::spawn({
            let work = d.path().to_path_buf();
            async move {
                run_with(
                    shell("sleep 30 & echo $! > child.pid; wait"),
                    &job,
                    &work,
                    cancel,
                    Duration::from_secs(60),
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop.send(()).unwrap();
        assert_eq!(running.await.unwrap().unwrap_err(), "任务已取消");
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: i32 = tokio::fs::read_to_string(d.path().join("child.pid"))
            .await
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        // SAFETY: signal 0 only checks whether the process still exists.
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "the grandchild was stopped too"
        );
    }

    #[test]
    fn keeps_the_end_of_long_logs_on_a_char_boundary() {
        let log = format!("{}结束", "日".repeat(LOG_LIMIT));
        let kept = tail(&log);
        assert!(kept.len() <= LOG_LIMIT && kept.ends_with("结束"));
    }
}
