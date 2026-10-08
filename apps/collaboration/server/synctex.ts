/**
 * Minimal SyncTeX reader for PDF <-> source jumps, without the `synctex` binary.
 * Coordinates are returned in PDF points (bp) from the page's top-left corner,
 * which is how PDF.js lays out a page viewport at scale 1.
 */
import { gunzipSync } from "node:zlib";
import { slashes } from "./util";

/** latexmk -outdir inside the build directory; its .aux files are not sources. */
export const OUTPUT_DIR = "build-output";

type Box = {
  kind: string;
  tag: number;
  line: number;
  h: number;
  v: number;
  w: number;
  height: number;
  depth: number;
};
export type SyncTex = { inputs: Map<number, string>; pages: Map<number, Box[]> };

export function parseSyncTex(gzipped: Uint8Array, buildDir: string): SyncTex {
  const text = gunzipSync(gzipped).toString("utf8");
  const inputs = new Map<number, string>();
  const pages = new Map<number, Box[]>();
  let unit = 1,
    magnification = 1000,
    xOffset = 0,
    yOffset = 0,
    page = 0;
  // Windows: Node gives D:\build, TeX may write D:/build or d:\build.
  const root = slashes(buildDir).replace(/\/+$/, "");
  for (const line of text.split("\n")) {
    if (line.startsWith("Input:")) {
      const match = /^Input:(\d+):(.*)$/.exec(line);
      if (!match?.[1] || match[2] === undefined) continue;
      // Only files inside the build directory belong to the project.
      let path = slashes(match[2]);
      if (!path.startsWith(`${root}/`)) continue;
      path = path
        .slice(root.length + 1)
        .split("/")
        .filter((part) => part && part !== ".")
        .join("/");
      if (!path.startsWith(`${OUTPUT_DIR}/`)) inputs.set(Number(match[1]), path);
    } else if (line.startsWith("Unit:")) unit = Number(line.slice(5)) || 1;
    else if (line.startsWith("Magnification:")) magnification = Number(line.slice(14)) || 1000;
    else if (line.startsWith("X Offset:")) xOffset = Number(line.slice(9)) || 0;
    else if (line.startsWith("Y Offset:")) yOffset = Number(line.slice(9)) || 0;
    else if (line.startsWith("{")) page = Number(line.slice(1));
    else if (page) {
      const record =
        /^([[(vhxkg$])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/.exec(line);
      if (!record) continue;
      // SyncTeX values are scaled points (1/65536 pt); 1 bp = 72.27/72 pt.
      const scale = (unit * magnification) / 1000 / 65781.76;
      const box: Box = {
        kind: record[1] ?? "",
        tag: Number(record[2]),
        line: Number(record[3]),
        h: (Number(record[4]) + xOffset) * scale,
        v: (Number(record[5]) + yOffset) * scale,
        w: Number(record[6] ?? 0) * scale,
        height: Number(record[7] ?? 0) * scale,
        depth: Number(record[8] ?? 0) * scale,
      };
      const list = pages.get(page) ?? [];
      list.push(box);
      pages.set(page, list);
    }
  }
  return { inputs, pages };
}

/** Source line -> first PDF region typeset from it (or from the nearest following line). */
export function forwardSearch(sync: SyncTex, file: string, line: number) {
  const tags = [...sync.inputs].filter(([, path]) => path === file).map(([tag]) => tag);
  if (!tags.length) return null;
  let best: { page: number; line: number } | null = null;
  for (const [page, boxes] of sync.pages) {
    for (const box of boxes) {
      if (!tags.includes(box.tag) || box.line < line) continue;
      if (!best || box.line < best.line || (box.line === best.line && page < best.page))
        best = { page, line: box.line };
    }
  }
  if (!best) return null;
  const target = best;
  const hits = (sync.pages.get(target.page) ?? []).filter(
    (b) => tags.includes(b.tag) && b.line === target.line,
  );
  // Leaf records have no width; use hbox extents when available.
  const left = Math.min(...hits.map((b) => b.h)),
    right = Math.max(...hits.map((b) => b.h + b.w)),
    top = Math.min(...hits.map((b) => b.v - Math.max(b.height, 8))),
    bottom = Math.max(...hits.map((b) => b.v + b.depth));
  return {
    page: target.page,
    line: target.line,
    x: left,
    y: top,
    width: Math.max(right - left, 4),
    height: Math.max(bottom - top, 8),
  };
}

/** PDF point on a page -> nearest project source line. */
export function inverseSearch(sync: SyncTex, page: number, x: number, y: number) {
  const boxes = (sync.pages.get(page) ?? []).filter((b) => sync.inputs.has(b.tag));
  if (!boxes.length) return null;
  const containing = boxes
    .filter(
      (b) =>
        (b.kind === "(" || b.kind === "[") &&
        x >= b.h &&
        x <= b.h + b.w &&
        y >= b.v - b.height &&
        y <= b.v + b.depth,
    )
    .sort((a, b) => a.w * (a.height + a.depth) - b.w * (b.height + b.depth));
  const inner = containing[0];
  const leaves = boxes.filter(
    (b) =>
      "xkg$h".includes(b.kind) &&
      (!inner ||
        (b.h >= inner.h - 0.5 &&
          b.h <= inner.h + inner.w + 0.5 &&
          b.v >= inner.v - inner.height - 0.5 &&
          b.v <= inner.v + inner.depth + 0.5)),
  );
  const pool = leaves.length ? leaves : boxes;
  let best = pool[0];
  let score = Number.POSITIVE_INFINITY;
  for (const b of pool) {
    // Prefer the record on the same baseline, just left of the click.
    const s = Math.abs(b.v - y) * 3 + (b.h <= x ? x - b.h : (b.h - x) * 2);
    if (s < score) {
      score = s;
      best = b;
    }
  }
  if (!best) return null;
  const file = sync.inputs.get(best.tag);
  return file ? { file, line: best.line } : null;
}
