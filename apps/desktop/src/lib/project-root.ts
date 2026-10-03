/**
 * Rust reports canonical project roots (symlinks and /var -> /private/var resolved), while the
 * UI keys buffers, drafts and panels by the path the user opened. Map backend roots back.
 */
const opened = new Map<string, string>();

export function rememberProjectRoot(path: string, canonical: string | null | undefined) {
  if (canonical && canonical !== path) opened.set(canonical, path);
}

export function openedProjectPath(path: string): string {
  return opened.get(path) ?? path;
}

export function sameProject(a: string, b: string): boolean {
  return openedProjectPath(a) === openedProjectPath(b);
}
