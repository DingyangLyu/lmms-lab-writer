use std::{
    io::Read,
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 5000;
fn ignored(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some(".git" | "node_modules" | "__MACOSX" | ".DS_Store" | ".lmms_lab_writer")
        )
    })
}
fn safe_name(name: &str) -> Result<PathBuf, String> {
    if name.contains('\\') || name.contains(':') || name.chars().any(|c| c.is_control()) {
        return Err(tr!(
            "模板包含不安全的文件名",
            "The template contains an unsafe file name"
        )
        .into());
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(tr!(
            "模板包含越界路径",
            "The template contains a path that escapes its folder"
        )
        .into());
    }
    Ok(path.into())
}
fn copy_folder(source: &Path, dest: &Path) -> Result<(), String> {
    let mut total = 0;
    let mut count = 0;
    for entry in walkdir::WalkDir::new(source).into_iter().filter_entry(|e| {
        e.depth() == 0 || !ignored(e.path().strip_prefix(source).unwrap_or(e.path()))
    }) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.depth() == 0 {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|e| e.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(tr!("模板含符号链接，请将链接替换为实际文件后再导入", "The template contains symbolic links; replace them with real files before importing").into());
        }
        let target = dest.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
        } else if entry.file_type().is_file() {
            count += 1;
            total += entry.metadata().map_err(|e| e.to_string())?.len();
            if count > MAX_FILES || total > MAX_BYTES {
                return Err(tr!(
                    "模板超过 5000 个文件或 256 MB",
                    "The template has more than 5000 files or 256 MB"
                )
                .into());
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut from = std::fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            let mut to = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut from, &mut to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn extract(source: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| {
        trf!(
            "无法读取 ZIP 模板：{e}",
            "Could not read the ZIP template: {e}"
        )
    })?;
    if zip.len() > MAX_FILES {
        return Err(tr!("ZIP 文件过多", "The ZIP has too many files").into());
    }
    let mut total = 0;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().trim_end_matches('/');
        if name.is_empty() {
            continue;
        }
        let relative = safe_name(name)?;
        if ignored(&relative) {
            continue;
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(tr!(
                "ZIP 中的符号链接不受支持",
                "Symbolic links in the ZIP are not supported"
            )
            .into());
        }
        let target = dest.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
            continue;
        }
        if total + file.size() > MAX_BYTES {
            return Err(tr!(
                "ZIP 解压后超过 256 MB",
                "The ZIP is over 256 MB when extracted"
            )
            .into());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut to = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| {
                trf!(
                    "模板文件名重复或无法写入：{e}",
                    "A template file name is duplicated or cannot be written: {e}"
                )
            })?;
        let written = std::io::copy(&mut (&mut file).take(MAX_BYTES - total + 1), &mut to)
            .map_err(|e| e.to_string())?;
        total += written;
        if total > MAX_BYTES {
            return Err(tr!("ZIP 条目超过大小限制", "A ZIP entry is over the size limit").into());
        }
    }
    Ok(())
}
fn import(source: &Path, parent: &Path, name: &str) -> Result<String, String> {
    let name_path = safe_name(name)?;
    if name_path.components().count() != 1 || name.trim().is_empty() {
        return Err(tr!("请使用一个新文件夹名称", "Use a new folder name").into());
    }
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if source.is_dir()
        && parent.starts_with(std::fs::canonicalize(source).map_err(|e| e.to_string())?)
    {
        return Err(tr!(
            "项目存放位置不能位于模板文件夹内部",
            "The project cannot be placed inside the template folder"
        )
        .into());
    }
    let dest = parent.join(&name_path);
    if dest.exists() {
        return Err(tr!("目标文件夹已存在，请换一个名称；不会覆盖已有项目", "The target folder already exists; choose another name. Existing projects are never overwritten").into());
    }
    let staging = parent.join(format!(".writer-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        if source.is_dir() {
            copy_folder(source, &staging)?;
        } else {
            extract(source, &staging)?;
        }
        let children = std::fs::read_dir(&staging)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let imported_root = if children.len() == 1 && children[0].path().is_dir() {
            children[0].path()
        } else {
            staging.clone()
        };
        if !walkdir::WalkDir::new(&imported_root)
            .into_iter()
            .filter_map(Result::ok)
            .any(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("tex"))
            })
        {
            return Err(tr!("模板里没有 .tex 文件", "The template has no .tex file").into());
        }
        std::fs::create_dir(&dest).map_err(|e| {
            trf!(
                "无法创建新项目：{e}",
                "Could not create the new project: {e}"
            )
        })?;
        if let Err(error) = copy_folder(&imported_root, &dest) {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(error);
        }
        Ok(dest.to_string_lossy().into_owned())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}
#[tauri::command]
pub async fn latex_import_template(
    source: String,
    parent: String,
    name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || import(Path::new(&source), Path::new(&parent), &name))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_zip_slip_and_absolute_names() {
        for name in ["../main.tex", "/etc/hosts", "C:/main.tex", "a\\..\\b.tex"] {
            assert!(safe_name(name).is_err());
        }
        assert!(safe_name("模板/main.tex").is_ok());
    }
    #[test]
    fn imports_into_new_folder_and_never_overwrites_existing_project() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("paper.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(source.join("style.sty"), "template style").unwrap();
        let result = import(&source, tmp.path(), "new-paper").unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&result).join("style.sty")).unwrap(),
            "template style"
        );
        assert!(import(&source, tmp.path(), "new-paper").is_err());
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use std::io::Write;
    fn zip_file(path: &Path, entries: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    #[test]
    fn imports_zip_with_template_support_files_and_rejects_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let zip = temp.path().join("template.zip");
        zip_file(
            &zip,
            &[
                ("template/main.tex", "\\documentclass{article}"),
                ("template/conference.sty", "style"),
                ("template/references.bib", "bib"),
            ],
        );
        let result = import(&zip, temp.path(), "new-project").unwrap();
        assert!(Path::new(&result).join("conference.sty").exists());
        assert!(Path::new(&result).join("references.bib").exists());
        let bad = temp.path().join("bad.zip");
        zip_file(&bad, &[("../outside.tex", "not allowed")]);
        assert!(import(&bad, temp.path(), "bad-project").is_err());
        assert!(!temp.path().join("outside.tex").exists());
        assert!(!temp.path().join("bad-project").exists());
    }
}
