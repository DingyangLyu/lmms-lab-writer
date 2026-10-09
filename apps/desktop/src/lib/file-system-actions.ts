import type { FileSystemActions } from "@lmms-lab/workbench";
import { normalize } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";
import { Command } from "@tauri-apps/plugin-shell";
import { pathSync } from "@/lib/path";

async function runCommand(cmd: string, args: string[]): Promise<boolean> {
  try {
    const result = await Command.create(cmd, args).execute();
    return result.code === 0;
  } catch {
    return false;
  }
}

// Reveal file/folder in system file manager
async function revealInFileManager(path: string): Promise<void> {
  const os = platform();
  const normalizedPath = await normalize(path);

  if (os === "macos") {
    // macOS: open -R reveals the item in Finder
    const ok = await runCommand("open", ["-R", normalizedPath]);
    if (!ok) {
      await runCommand("open", [normalizedPath]);
    }
  } else if (os === "windows") {
    // Windows: explorer /select, requires the path as part of the argument
    // Pass /select,<path> as a single argument (Tauri will handle quoting)
    await runCommand("explorer", [`/select,${normalizedPath}`]);
  } else {
    // Linux: xdg-open opens the containing folder
    const parentPath = pathSync.dirname(normalizedPath) || normalizedPath;
    const ok = await runCommand("xdg-open", [parentPath]);
    if (!ok) {
      await runCommand("gio", ["open", parentPath]);
    }
  }
}

// Open folder in system terminal
async function openInTerminal(folderPath: string): Promise<void> {
  const os = platform();
  const normalizedPath = await normalize(folderPath);

  if (os === "macos") {
    // macOS: open Terminal.app at the folder
    await runCommand("open", ["-a", "Terminal", normalizedPath]);
  } else if (os === "windows") {
    // Windows: open cmd or Windows Terminal at the folder
    // Try Windows Terminal first, fall back to cmd
    const wtOk = await runCommand("wt", ["-d", normalizedPath]);
    if (!wtOk) {
      await runCommand("cmd", ["/c", "start", "cmd", "/k", `cd /d "${normalizedPath}"`]);
    }
  } else {
    // Linux: try common terminal emulators
    const terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
    for (const term of terminals) {
      const ok = await runCommand(term, ["--working-directory", normalizedPath]);
      if (ok) break;
    }
  }
}

/** What the shared file tree may do with the operating system. */
export const desktopFileSystem: FileSystemActions = {
  get platform() {
    const os = platform();
    return os === "macos" || os === "windows" ? os : "linux";
  },
  reveal: revealInFileManager,
  openTerminal: openInTerminal,
  normalize,
};
