/**
 * Desktop installers for members to download: whatever the operator put in
 * WRITER_DOWNLOADS_DIR (the files of a GitHub release), listed by platform. Large files are
 * sent with ranges, so a broken download over a slow tunnel can resume.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopDownloads, DesktopInstaller } from "../../shared/api";
import { type Authed, handled, route } from "../http";
import { fail } from "../util";

const KINDS: Array<[RegExp, DesktopInstaller["platform"], DesktopInstaller["kind"]]> = [
  [/\.pkg$/i, "macos", "pkg"],
  [/\.dmg$/i, "macos", "dmg"],
  [/\.exe$/i, "windows", "exe"],
  [/\.msi$/i, "windows", "msi"],
  [/\.appimage$/i, "linux", "appimage"],
  [/\.deb$/i, "linux", "deb"],
  [/\.rpm$/i, "linux", "rpm"],
];
const NAME = /^[\w.+-]{1,200}$/;

/** What a release file is, from its name (Tauri's: `Y-Writer_0.2.0_aarch64.dmg`, …). */
export function installer(name: string) {
  const known = NAME.test(name) ? KINDS.find(([pattern]) => pattern.test(name)) : undefined;
  if (!known) return null;
  const arch: DesktopInstaller["arch"] = /aarch64|arm64/i.test(name)
    ? "arm64"
    : /x64|x86_64|amd64/i.test(name)
      ? "x64"
      : null;
  return { platform: known[1], kind: known[2], arch };
}

async function list(directory: string | null): Promise<DesktopDownloads> {
  const names = directory ? await readdir(directory).catch(() => []) : [];
  const installers: DesktopInstaller[] = [];
  for (const name of names.sort()) {
    const kind = installer(name);
    const info = kind && (await stat(join(directory as string, name)).catch(() => null));
    if (kind && info?.isFile())
      installers.push({ name, ...kind, bytes: info.size, updated: info.mtimeMs });
  }
  // Tauri names most files `<app>_<version>_<arch>`; an .rpm adds its own release number.
  const version =
    installers.map((i) => /_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_/.exec(i.name)?.[1]).find(Boolean) ??
    installers.map((i) => /(\d+\.\d+\.\d+)/.exec(i.name)?.[1]).find(Boolean);
  return { version: version ?? null, installers };
}

export const downloadRoutes = [
  route<Authed>("GET", /^\/api\/downloads$/, (ctx) => list(ctx.downloads)),
  route<Authed>("GET", /^\/api\/downloads\/([^/]+)$/, async (ctx, [raw = ""]) => {
    const name = decodeURIComponent(raw);
    if (!ctx.downloads || !installer(name)) fail(404, "没有这个安装包");
    const path = join(ctx.downloads, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) fail(404, "没有这个安装包");
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(ctx.req.headers.range ?? ""));
    const start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (range && (start >= info.size || start > end)) {
      ctx.res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      ctx.res.end();
      return handled;
    }
    ctx.res.writeHead(range ? 206 : 200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": end - start + 1,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { start, end });
      stream.on("error", reject);
      ctx.res.on("close", () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(ctx.res);
    });
    return handled;
  }),
];
