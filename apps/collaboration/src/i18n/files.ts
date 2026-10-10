export const filesZh = {
  "files.tooLarge":
    "{path} 太大（文本文件最多 2 MB，其他文件最多 100 MB），已导入 {count} 个文件。",
  "files.imported": "已导入 {count} 个文件。",
  "files.upload": "上传文件",
  "files.dropToUpload": "松开鼠标，上传到项目根目录",
  "files.importFolder": "导入文件夹",
  "files.newPrompt": "新文件相对路径，例如 main.tex",
};
export const filesEn: Record<keyof typeof filesZh, string> = {
  "files.tooLarge":
    "{path} is too large (text files up to 2 MB, other files up to 100 MB); {count} {count|file was|files were} imported.",
  "files.imported": "Imported {count} {count|file|files}.",
  "files.upload": "Upload files",
  "files.dropToUpload": "Drop to upload to the project's top folder",
  "files.importFolder": "Import folder",
  "files.newPrompt": "Path of the new file, e.g. main.tex",
};
