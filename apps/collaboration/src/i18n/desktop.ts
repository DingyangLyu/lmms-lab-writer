export const desktopZh = {
  "nav.desktop": "桌面端",
  "desktop.title": "下载桌面端",
  "desktop.lead":
    "在自己的电脑上写作：本地文件夹、离线编辑、本机的 AI 工具和 Git 版本。与这个服务器关联的项目会和网页实时同步。",
  "desktop.version": "版本 {version}",
  "desktop.forYou": "适合这台电脑",
  "desktop.all": "全部安装包",
  "desktop.none":
    "服务器上还没有安装包。管理员把 GitHub Release 里的安装包放进服务器的下载目录（WRITER_DOWNLOADS_DIR）后，会出现在这里。",
  "desktop.download": "下载",
  "desktop.size": "{size} MB",
  "desktop.arm64Mac": "Apple 芯片（M 系列）",
  "desktop.x64Mac": "Intel 芯片",
  "desktop.arm64": "ARM64",
  "desktop.x64": "x64",
  "desktop.kind.pkg": "安装器 .pkg（推荐）",
  "desktop.kind.dmg": "磁盘映像 .dmg",
  "desktop.kind.exe": "安装程序 .exe（推荐）",
  "desktop.kind.msi": "MSI 安装包",
  "desktop.kind.appimage": "AppImage（免安装）",
  "desktop.kind.deb": "Debian / Ubuntu .deb",
  "desktop.kind.rpm": "Fedora / openSUSE .rpm",
  "desktop.installTitle": "安装说明",
  "desktop.installMac":
    "推荐 .pkg：双击按提示安装，会自动解除系统隔离。用 .dmg 安装后如果提示“已损坏”或“无法验证开发者”，在终端运行：",
  "desktop.installWindows":
    "安装包没有代码签名，SmartScreen 拦截时点“更多信息”→“仍要运行”。电脑缺少 WebView2 时，安装程序会自动下载。",
  "desktop.installLinux": "AppImage 下载后执行 chmod +x 再运行；.deb / .rpm 用系统的包管理器安装。",
  "desktop.connectTitle": "连接这个服务器",
  "desktop.connect":
    "打开桌面端，在“协作服务器”里填写服务器地址 {origin}，用这里的账号登录，再选“从协作服务器打开”项目；它会下载到你选的文件夹并保持同步。也可以在网页的项目里点“菜单”→“在桌面端打开”。",
};
export const desktopEn: Record<keyof typeof desktopZh, string> = {
  "nav.desktop": "Desktop",
  "desktop.title": "Download the desktop app",
  "desktop.lead":
    "Write on your own computer: local folders, offline editing, your own AI tools and Git versions. Projects linked to this server stay in sync with the web.",
  "desktop.version": "Version {version}",
  "desktop.forYou": "For this computer",
  "desktop.all": "All installers",
  "desktop.none":
    "No installers on the server yet. Once an administrator puts a GitHub release's installers in the server's download folder (WRITER_DOWNLOADS_DIR), they appear here.",
  "desktop.download": "Download",
  "desktop.size": "{size} MB",
  "desktop.arm64Mac": "Apple silicon (M series)",
  "desktop.x64Mac": "Intel",
  "desktop.arm64": "ARM64",
  "desktop.x64": "x64",
  "desktop.kind.pkg": "Installer .pkg (recommended)",
  "desktop.kind.dmg": "Disk image .dmg",
  "desktop.kind.exe": "Setup .exe (recommended)",
  "desktop.kind.msi": "MSI package",
  "desktop.kind.appimage": "AppImage (no install)",
  "desktop.kind.deb": "Debian / Ubuntu .deb",
  "desktop.kind.rpm": "Fedora / openSUSE .rpm",
  "desktop.installTitle": "Installing",
  "desktop.installMac":
    "Use the .pkg: open it and follow the steps; it lifts macOS's quarantine for you. If the app from the .dmg is reported as damaged or from an unidentified developer, run in Terminal:",
  "desktop.installWindows":
    "The installer is not code-signed: when SmartScreen stops it, choose More info → Run anyway. It downloads WebView2 if the computer lacks it.",
  "desktop.installLinux":
    "Make the AppImage executable (chmod +x) and run it; install a .deb or .rpm with your package manager.",
  "desktop.connectTitle": "Connect to this server",
  "desktop.connect":
    "In the desktop app, open Collaboration, enter {origin} as the server, sign in with your account here and choose Open from collaboration server; the project is downloaded to a folder you pick and kept in sync. Or, in a project on the web, choose Menu → Open in the desktop app.",
};
