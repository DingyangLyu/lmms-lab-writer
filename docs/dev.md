# Developer Guide

Comprehensive technical documentation for contributing to LMMs-Lab Writer.

## Architecture Overview

LMMs-Lab Writer is a pnpm + Turbo monorepo containing a Tauri v2 desktop app, a Next.js marketing website, and shared packages.

```
lmms-lab-writer/
├── apps/
│   ├── desktop/                     # Tauri v2 desktop app (main product)
│   │   ├── src/                     # Next.js 16 frontend (React 19, static export)
│   │   │   ├── app/page.tsx         # Main editor layout
│   │   │   ├── components/          # 40+ React components
│   │   │   │   ├── editor/          # Editor, file tree, terminal, diff, git panel
│   │   │   │   ├── opencode/        # AI chat panel, messages, tools, sessions
│   │   │   │   ├── latex/           # Compiler settings, install prompt, main file picker
│   │   │   │   └── ui/              # Shared UI (tabs, dialogs, toast, context menu, scroll)
│   │   │   └── lib/tauri/           # Tauri IPC hooks (useTauriDaemon)
│   │   └── src-tauri/               # Rust backend
│   │       ├── src/
│   │       │   ├── lib.rs           # App entry, plugin init, command registration
│   │       │   ├── main.rs          # Binary entry (calls lib::run)
│   │       │   └── commands/        # IPC command modules
│   │       │       ├── fs.rs        # File operations, directory watching
│   │       │       ├── git.rs       # Git + GitHub CLI operations
│   │       │       ├── latex.rs     # Compilation, compiler detection, distribution install
│   │       │       ├── terminal.rs  # PTY spawn, write, resize, kill
│   │       │       ├── opencode.rs  # AI daemon start/stop/status
│   │       │       └── util.rs      # Path validation utilities
│   │       ├── capabilities/
│   │       │   └── default.json     # Tauri permissions & allowed shell commands
│   │       ├── tauri.conf.json      # App config (window, CSP, plugins, bundle)
│   │       └── Cargo.toml           # Rust dependencies
│   └── collaboration/               # Self-hosted multi-user server + web editor
│       ├── server/                  # Node HTTP/WebSocket API, PostgreSQL, LaTeX builds
│       ├── shared/api.ts            # JSON shapes shared by server and web client
│       └── src/                     # React + CodeMirror + Yjs web client
├── packages/
│   ├── shared/                      # Types shared with the desktop app
│   ├── writing/                     # Three-way merge, review hunks, bibliography
│   └── latex-editor/                # CodeMirror LaTeX grammar and folding
├── docs/                            # Project documentation
│   ├── dev.md                       # This file
│   ├── DESIGN.md                    # Design system (retro-terminal, monochrome + orange)
│   ├── MARKETING.md                 # Marketing copy & launch strategy
│   └── SCREENSHOT-GUIDE.md          # Asset capture guide
├── turbo.json                       # Build pipeline
├── pnpm-workspace.yaml              # Workspace definition
└── AGENTS.md                        # AI agent development guide
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop Framework | Tauri v2 (Rust backend) | 2.x |
| Frontend Framework | Next.js (desktop), Vite (collaboration) | 16.x / 8.x |
| UI Library | React | 19.2.4 |
| LaTeX Editor | CodeMirror 6 | 6.x |
| File Editor / Diff | Monaco Editor | 0.55.1 |
| Terminal Emulator | xterm.js | 6.0.0 |
| PTY | portable-pty | 0.8 |
| UI Styling | Tailwind CSS 4 | 4.x (desktop) |
| UI Components | Radix UI | various |
| Icons | Phosphor Icons | |
| Animation | Framer Motion | 12.29.2 |
| Async Runtime | Tokio | 1.x (full features) |
| File Watching | notify | 6.x |
| HTTP Client | reqwest | 0.12 |
| Serialization | serde + serde_json | 1.x |
| Collaboration Database | PostgreSQL (PGlite for tests) | 17 |
| CRDT / Realtime | Yjs | 13.6.29 |
| Build Orchestration | Turbo | 2.9.16 |
| Package Manager | pnpm | 11.5.0 |
| Language | TypeScript 6.0.3 (strict), Rust 2021 edition | |
| Node.js | >= 24.0.0 | Active LTS; required by CI |

## Prerequisites

Ensure you have the following installed:

1. **Node.js** >= 24.0.0 — [nodejs.org](https://nodejs.org/)
2. **pnpm** 11.x — managed by Corepack / `corepack enable`
3. **Rust** toolchain — [rustup.rs](https://rustup.rs/)
4. **Platform-specific Tauri dependencies**:
   - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
   - **Windows**: Visual Studio C++ Build Tools, WebView2 (usually pre-installed on Windows 10+)
   - See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for full details

## Getting Started

```bash
# Clone the repository
git clone https://github.com/EvolvingLMMs-Lab/lmms-lab-writer.git
cd lmms-lab-writer

# Install dependencies
pnpm install

# Run desktop app in dev mode (frontend + Tauri)
pnpm tauri:dev

# Run the collaboration server and web editor
pnpm --filter @lmms-lab/writer-collaboration dev
```

### All Commands

```bash
# Development
pnpm tauri:dev                              # Desktop app with hot reload
pnpm --filter @lmms-lab/writer-collaboration dev   # Collaboration server

# Build
pnpm build                                  # Build all packages
pnpm tauri:build                            # Build desktop app (.app/.pkg/.exe/.msi)
pnpm --filter @lmms-lab/writer-collaboration build # Build the web editor

# Type Checking
cd apps/desktop/src-tauri && cargo check    # Rust
pnpm typecheck                              # TypeScript in every package

# Lint & Format
pnpm lint                                   # Biome check
pnpm lint:fix                               # Biome safe fixes
pnpm format                                 # Biome formatter
```

### Build Output Locations

```
macOS:   apps/desktop/src-tauri/target/release/bundle/macos/LMMs-Lab Writer.app
         apps/desktop/src-tauri/target/release/bundle/dmg/LMMs-Lab Writer_*.dmg
Windows: apps/desktop/src-tauri/target/release/bundle/nsis/LMMs-Lab Writer_*-setup.exe
         apps/desktop/src-tauri/target/release/bundle/msi/LMMs-Lab Writer_*.msi
Linux:   apps/desktop/src-tauri/target/release/bundle/appimage/LMMs-Lab Writer_*.AppImage
         apps/desktop/src-tauri/target/release/bundle/deb/lmms-lab-writer_*.deb
```

## Desktop App Architecture

### Frontend → Backend Communication

The React frontend communicates with the Rust backend through Tauri's IPC (Inter-Process Communication). All IPC calls are routed through a single React hook:

```
React Component
  → useTauriDaemon() hook  [apps/desktop/src/lib/tauri/use-tauri-daemon.ts]
    → invoke("command_name", { args })  [Tauri IPC]
      → Rust command handler  [apps/desktop/src-tauri/src/commands/*.rs]
```

### `useTauriDaemon` Hook

The central state management hook (`apps/desktop/src/lib/tauri/use-tauri-daemon.ts`) bridges the React frontend to the Rust backend. It manages:

**State slices:**

| Slice | Key Fields |
|-------|-----------|
| Project | `projectPath`, `projectInfo`, `files: FileNode[]` |
| Git | `gitStatus`, `gitLogEntries`, `gitGraph`, `isPushing`, `isPulling`, `ghStatus` |
| Operations | `isOpeningProject`, `isStaging`, `lastError` |

**Actions (file system):**

| Method | Description |
|--------|------------|
| `setProject(path)` | Initialize project workspace |
| `readFile(relativePath)` | Read file content |
| `writeFile(relativePath, content)` | Write file content |
| `createFile(relativePath)` | Create new file |
| `createDirectory(relativePath)` | Create new directory |
| `renamePath(oldPath, newPath)` | Rename/move file or directory |
| `deletePath(relativePath)` | Delete file or directory |
| `refreshFiles()` | Refresh file tree |

**Actions (git):**

| Method | Description |
|--------|------------|
| `refreshGitStatus(syncRemote?)` | Fetch status with optional remote sync |
| `gitAdd(files)` | Stage files |
| `gitUnstage(files)` | Unstage files |
| `gitCommit(message)` | Commit changes |
| `gitPush()` | Push to remote |
| `gitPull()` | Pull from remote |
| `gitInit()` | Initialize repo |
| `gitAddRemote(url, name?)` | Add remote |
| `gitDiscardAll()` | Discard all changes |
| `gitDiscardFile(file)` | Discard specific file |
| `gitDiff(file, staged?)` | Get diff output |

**Actions (GitHub CLI):**

| Method | Description |
|--------|------------|
| `ghCheck()` | Check installation and auth status |
| `ghAuthLogin()` | Browser-based device code auth (120s timeout) |
| `ghCreateRepo(name, isPrivate, description?)` | Create repo and push |

**Automatic behaviors:**
- File watching with debounced refresh (300ms files, 200ms git status)
- Periodic git auto-fetch when upstream exists (default 120s, min 15s)
- Proper cleanup on unmount

### Rust Command Modules

49 IPC commands organized into 7 modules:

#### `fs.rs` — File System (10 commands)

| Command | Purpose |
|---------|---------|
| `set_project_path` | Set active project directory |
| `read_file` | Read file content |
| `write_file` | Write file content |
| `get_file_tree` | Get recursive directory tree as `FileNode[]` |
| `watch_directory` | Start file system watcher (emits `files-changed` events) |
| `stop_watch` | Stop file watcher |
| `create_file` | Create new file |
| `create_directory` | Create new directory |
| `rename_path` | Rename/move path |
| `delete_path` | Delete file or directory |

All file operations validate paths stay within the project directory (see `util.rs`).

#### `git.rs` — Git + GitHub CLI (18 commands)

| Command | Purpose |
|---------|---------|
| `git_status` | Branch, remote, ahead/behind, file changes |
| `git_log` | Commit history (default 20 entries) |
| `git_graph` | ASCII visualization of commit history |
| `git_diff` | Diff for staged/unstaged changes |
| `git_add` | Stage files |
| `git_unstage` | Unstage files |
| `git_commit` | Create commit |
| `git_push` | Push to remote (handles initial branch setup) |
| `git_pull` | Pull from remote |
| `git_fetch` | Fetch all remotes |
| `git_init` | Init repo with LaTeX-specific `.gitignore` |
| `git_add_remote` | Add remote |
| `git_discard_all` | Discard all changes + remove untracked |
| `git_discard_file` | Discard specific file changes |
| `gh_check` | Check GitHub CLI installation and auth |
| `gh_auth_login` | Browser-based GitHub auth (device code flow) |
| `gh_create_repo` | Create GitHub repo with optional push |

#### `latex.rs` — LaTeX Compilation (8 commands)

| Command | Purpose |
|---------|---------|
| `latex_detect_compilers` | Detect available engines (pdflatex, xelatex, lualatex, latexmk) |
| `latex_stop_compilation` | Cancel running compilation |
| `latex_get_distributions` | List available LaTeX distributions for platform |
| `latex_install` | One-click install LaTeX distribution |
| `latex_open_download_page` | Open distribution download page in browser |

**Compiler detection** searches: system PATH → common platform-specific paths (e.g., `APPDATA\TinyTeX` on Windows, `/Library/TeX/texbin` on macOS).

**Main file detection** scoring:
- `\documentclass` present → +10
- `\begin{document}` present → +5
- Filename `main.tex` → +8, `paper.tex` → +5
- `chapter*`, `section*` → -3
- `preamble.tex`, `packages.tex` → -5

**Compilation** always includes `-interaction=nonstopmode` and `-file-line-error`. Output is parsed for errors (`!` prefix), warnings, and overfull/underfull box messages.

#### `terminal.rs` — PTY Terminal (4 commands)

| Command | Purpose |
|---------|---------|
| `spawn_pty` | Start pseudo-terminal session (shell auto-detected by platform) |
| `write_pty` | Send input data to PTY |
| `resize_pty` | Resize terminal on window change |
| `kill_pty` | Terminate PTY session |

Events: `pty-output` (data stream), `pty-exit` (process exit with code).

Default shells: Bash/Zsh (macOS/Linux), PowerShell (Windows). User-configurable custom shell path.

#### `opencode.rs` — OpenCode AI Integration (5 commands)

| Command | Purpose |
|---------|---------|
| `opencode_status` | Check if daemon is running and installed |
| `opencode_start` | Start daemon in project directory (default port 4096) |
| `opencode_stop` | Stop daemon gracefully |
| `opencode_restart` | Restart daemon |
| `kill_port_process` | Force kill process on port (for conflicts) |

The OpenCode daemon runs as a separate process (`opencode serve`) with stdio piped for log streaming.

#### `util.rs` — Shared Utilities

Path validation: ensures all file operations target paths within the project directory to prevent directory traversal.

### Managed State

The Rust app initializes these state objects at startup:

```rust
PtyState::default()                // Terminal session management
OpenCodeState::default()           // OpenCode daemon state
LaTeXCompilationState::default()   // Active compilation tracking
Mutex<WatcherState>                // File system watcher
Mutex<ProjectState>                // Current project path
Arc<TokioMutex<AuthCallbackState>> // OAuth callback server
```

### Tauri Plugins

```rust
tauri_plugin_shell       // Shell command execution
tauri_plugin_opener      // Open URLs/files in default app
tauri_plugin_fs          // File system access
tauri_plugin_dialog      // Native file/folder dialogs
tauri_plugin_process     // Process management
tauri_plugin_notification // Desktop notifications
tauri_plugin_os          // OS info
tauri_plugin_deep_link   // lmms-writer:// URL scheme
tauri_plugin_updater     // Auto-update (desktop only)
```

### Tauri Permissions

All permissions are defined in `apps/desktop/src-tauri/capabilities/default.json`. Notable allowed shell commands:

```
git, latexmk, opencode, sh -c (any), open (macOS), explorer (Windows), xdg-open (Linux)
```

### Tauri App Configuration

| Setting | Value |
|---------|-------|
| App Identifier | `com.lmms-lab.writer` |
| Window Size | 1400 x 900 (min 960 x 640) |
| Deep Link Scheme | `lmms-writer://` |
| Frontend (dev) | `http://localhost:3000` |
| Frontend (prod) | Bundled static export (`../out`) |
| macOS Minimum | 10.15 |
| CSP | Allows self, unsafe-inline, unsafe-eval, assets and local servers |

## Shared Types

`packages/shared/src/index.ts` holds the JSON shapes the desktop frontend receives from the Rust
commands: `FileNode` (file tree), `GitInfo`, `GitStatus`, `GitFileChange` and `GitLogEntry`. Like the
other workspace packages it exports TypeScript source directly; Next.js transpiles it, so there is no
separate build step.

## Turbo Build Pipeline

Defined in `turbo.json`:

```json
{
  "build": {
    "dependsOn": ["^build"],       // Build dependencies first
    "inputs": ["$TURBO_DEFAULT$", ".env*"],
    "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
  },
  "dev": { "cache": false, "persistent": true },
  "lint": { "dependsOn": ["^build"] },
  "typecheck": { "dependsOn": ["^build"] }
}
```


## Conventions

### TypeScript

- `strict: true` with `noUncheckedIndexedAccess: true` — array access returns `T | undefined`
- No `as any`, no `@ts-ignore`

### File Naming

- Files: `kebab-case.ts` / `kebab-case.tsx`
- Components: `PascalCase`
- Functions/hooks: `camelCase`

### Design System

**"Retro-Terminal Fintech"** — Monochrome + orange accent. No rounded corners.

| Token | Value | Usage |
|-------|-------|-------|
| `background` | `#f5f5f0` | Page background (warm gray) |
| `foreground` | `#000000` | Primary text |
| `accent` | `#ff5500` | Primary accent (orange) |
| `border` | `#e5e5e5` | Subtle borders |
| `muted` | `#666666` | Secondary text |

See `docs/DESIGN.md` for the full design system.

### Layout Alignment

All pages use a consistent container pattern:

```tsx
// Sections with padding
<section className="px-6">
  <div className="max-w-5xl mx-auto">
    {content}
  </div>
</section>

// Full-width elements (header, footer)
<header className="border-b border-border px-6">
  <div className="max-w-5xl mx-auto">
    {content}
  </div>
</header>
```

Rules:
- `px-6` on the outer element, never inside `max-w-5xl`
- All pages use `max-w-5xl` for main container width
- Inner content can use `max-w-2xl`, `max-w-sm` etc. for reading width

## Debugging

### Quick Start

```bash
# 1. Start dev mode
pnpm tauri:dev

# 2. Open DevTools
#    macOS:   ⌥⌘I
#    Windows: Ctrl+Shift+I

# 3. Check Console tab for errors
```

### Debug Layers

Check in order when something breaks:

| Layer | What to Check | Tool |
|-------|--------------|------|
| 1. Frontend (React) | Console errors, component renders | DevTools Console |
| 2. IPC Bridge | `invoke()` calls, event listeners | DevTools Network + Console |
| 3. Rust Backend | Command execution, panics | Terminal running `tauri dev` |
| 4. Tauri Plugins | Plugin init, permissions | `capabilities/default.json` |

### Diagnostic Commands

```bash
# Frontend compiles?
cd apps/desktop && pnpm tsc --noEmit

# Rust compiles?
cd apps/desktop/src-tauri && cargo check

# Dev server running? (macOS/Linux)
lsof -i :3000

# Dev server running? (Windows)
netstat -ano | findstr :3000

# Kill stuck processes (macOS/Linux)
pkill -f "tauri" && pkill -f "next"

# Kill stuck processes (Windows)
taskkill /f /im "lmms-lab-writer.exe" 2>nul & taskkill /f /im "node.exe" /fi "WINDOWTITLE eq next" 2>nul
```

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Clicks do nothing | JS error broke hydration | Check Console for errors |
| Dialog doesn't open | Plugin permission missing | Check `capabilities/default.json` |
| IPC timeout | Rust command panicked | Check terminal for Rust errors |
| Stale UI | Hot reload failed | Restart `pnpm tauri:dev` |
| `invoke not found` | Tauri API not loaded | Check `withGlobalTauri: true` in `tauri.conf.json` |
| PTY not working | Terminal spawn failed | Check shell path exists |

### Key Files to Check

| Issue Area | Files |
|-----------|-------|
| UI / click handlers | `apps/desktop/src/app/page.tsx` |
| Tauri IPC hooks | `apps/desktop/src/lib/tauri/use-tauri-daemon.ts` |
| Rust commands | `apps/desktop/src-tauri/src/commands/*.rs` |
| Plugin permissions | `apps/desktop/src-tauri/capabilities/default.json` |
| Tauri config | `apps/desktop/src-tauri/tauri.conf.json` |

## Anti-Patterns

| Don't Do This | Why |
|---------------|-----|
| `as any`, `@ts-ignore` | Type safety is non-negotiable |
| `rounded-*` classes | Sharp corners only (design system) |
| Colors beyond grayscale + orange | Monochrome + accent design |
| `std::fs` in async Rust | Use `tokio::fs` or `spawn_blocking` |
| `std::thread::sleep` in async | Use `tokio::time::sleep` |
| `std::process::Command` in async | Use `tokio::process::Command` |

## Performance Guidelines

### Frontend (React/Next.js)

1. **State splitting** — Split large state objects into smaller slices to prevent unnecessary re-renders
2. **Memoization** — Use `React.memo` for components that receive stable props
3. **Parallel I/O** — Use `Promise.all` for independent async operations
4. **Dynamic imports** — Heavy components (Terminal, OpenCodePanel, Monaco) should use `next/dynamic`

### Backend (Rust/Tauri)

1. **Async I/O** — Use `tokio::fs` instead of `std::fs` in async handlers
2. **Process management** — Use `tokio::process::Command` instead of `std::process::Command`
3. **IPC throttling** — Buffer high-frequency events (compile output, PTY data) before emitting
4. **Parallel git** — Run independent git commands with `tokio::join!`
5. **Path validation** — All file operations must validate paths are within the project directory (see `util.rs`)

### Rust Release Profile

```toml
[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"    # Optimize for size
strip = true
```

## Key Dependencies Reference

### Rust (`Cargo.toml`)

| Crate | Version | Purpose |
|-------|---------|---------|
| tauri | 2 | Desktop framework |
| tauri-plugin-shell | 2 | Shell command execution |
| tauri-plugin-fs | 2 | File system access |
| tauri-plugin-dialog | 2 | Native dialogs |
| tauri-plugin-deep-link | 2 | URL scheme handling |
| tauri-plugin-updater | 2 | Auto-update |
| tokio | 1 (full) | Async runtime |
| serde / serde_json | 1 | Serialization |
| reqwest | 0.12 | HTTP client |
| notify | 6 | File system events |
| portable-pty | 0.8 | Pseudo-terminal |
| walkdir | 2 | Directory traversal |
| uuid | 1 (v4) | UUID generation |

### Frontend (`package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| react / react-dom | 19.2.4 | UI library |
| next | 16.1.5 | Framework (static export) |
| @codemirror/* | 6.x | LaTeX editor |
| monaco-editor | 0.55.1 | File editor + diff viewer |
| monaco-vim | 0.4.0 | Vim keybindings |
| @xterm/xterm | 6.0.0 | Terminal emulator |
| @radix-ui/* | various | Headless UI components |
| framer-motion | 12.29.2 | Animations |
| tailwindcss | 4.1.18 | Styling |
| @tauri-apps/api | 2.9.1 | Tauri IPC bridge |
| yjs | 13.6.29 | CRDT for realtime (future) |
| react-arborist | 3.4.3 | File tree |
| react-pdf | 10.3.0 | PDF preview |
| katex | 0.16.28 | Math rendering |
