export const filesZh = {
  "files.tooLarge": "{path} 太大，已导入 {count} 个文件。",
  "files.imported": "已导入 {count} 个文件。",
  "files.upload": "上传文件",
  "files.importFolder": "导入文件夹",
  "files.newPrompt": "新文件相对路径，例如 main.tex",
};
export const filesEn: Record<keyof typeof filesZh, string> = {
  "files.tooLarge": "{path} is too large; {count} {count|file was|files were} imported.",
  "files.imported": "Imported {count} {count|file|files}.",
  "files.upload": "Upload files",
  "files.importFolder": "Import folder",
  "files.newPrompt": "Path of the new file, e.g. main.tex",
};
