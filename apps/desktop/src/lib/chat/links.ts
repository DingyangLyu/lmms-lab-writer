export type ChatLinkTarget =
  | { kind: "file"; path: string; line?: number; column?: number; page?: number }
  | { kind: "external-file"; path: string; line?: number; column?: number; page?: number }
  | { kind: "external"; url: string }
  | { kind: "blocked" };
/** Parse links before the renderer/browser can turn a local path into a navigation. */
export function parseChatLink(href: string, project?: string): ChatLinkTarget {
  let value = href.trim();
  let decoded = false;
  let appDocument = false;
  // URL fragments/queries are split before decoding, so %23 and %3F stay part of a filename.
  let fragment = "";
  if (!value) return { kind: "blocked" };
  if (/^(https?:|mailto:)/i.test(value)) {
    if (/^https?:\/\/(?:tauri\.localhost|asset\.localhost|localhost(?=[:/]))/i.test(value)) {
      try {
        const url = new URL(value);
        if (!["tauri.localhost", "asset.localhost"].includes(url.hostname))
          return { kind: "external", url: value };
        value = decodeURIComponent(url.pathname);
        fragment = url.hash.slice(1);
        decoded = true;
        appDocument = true;
      } catch {
        return { kind: "blocked" };
      }
    } else return { kind: "external", url: value };
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return { kind: "blocked" };
      value = decodeURIComponent(url.pathname);
      fragment = url.hash.slice(1);
      decoded = true;
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    } catch {
      return { kind: "blocked" };
    }
  } else if (/^tauri:\/\/localhost\//i.test(value)) {
    try {
      const url = new URL(value);
      value = decodeURIComponent(url.pathname);
      fragment = url.hash.slice(1);
      decoded = true;
      appDocument = true;
    } catch {
      return { kind: "blocked" };
    }
  } else if (
    /^[a-z][a-z\d+.-]*:/i.test(value) &&
    !/^([A-Za-z]:[\\/]|[^:]+\.[a-z\d]+:\d)/i.test(value)
  )
    return { kind: "blocked" };
  if (!decoded) {
    const hash = value.indexOf("#");
    if (hash >= 0) {
      fragment = value.slice(hash + 1);
      value = value.slice(0, hash);
    }
    value = value.replace(/\?.*$/, "");
    try {
      value = decodeURIComponent(value);
    } catch {
      return { kind: "blocked" };
    }
  }
  if (Array.from(value).some((char) => char.charCodeAt(0) < 32) || value.startsWith("//"))
    return { kind: "blocked" };
  value = value.replace(/\\/g, "/");
  let line: number | undefined, column: number | undefined, page: number | undefined;
  const position = value.match(/:(\d+)(?::(\d+))?$/);
  if (position) {
    line = Number(position[1]);
    column = position[2] ? Number(position[2]) : undefined;
    value = value.slice(0, position.index);
  }
  const anchor = fragment.match(/^L?(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i);
  if (anchor) {
    line = Number(anchor[1]);
    column = anchor[2] ? Number(anchor[2]) : column;
  }
  const pdfPage = fragment.match(/(?:^|&)page=(\d+)/i);
  if (pdfPage) page = Number(pdfPage[1]);
  if (!value) return { kind: "blocked" };
  const root = project?.replace(/\\/g, "/").replace(/\/$/, "");
  const comparisonRoot = root && /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
  if (appDocument && /^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  if (
    appDocument &&
    value.startsWith("/") &&
    (!root || (value !== root && !value.startsWith(`${root}/`)))
  )
    value = value.slice(1);
  const comparisonValue = comparisonRoot !== root ? value.toLowerCase() : value;
  if (
    root &&
    (comparisonValue === comparisonRoot || comparisonValue.startsWith(`${comparisonRoot}/`))
  )
    value = value.slice(root.length).replace(/^\//, "");
  else if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    // Absolute local artifacts are often created by an agent outside the open
    // project (for example an editable PPTX). They are safe to reveal in the
    // native file manager, but must never be loaded into the project editor.
    if (root)
      return {
        kind: "external-file",
        path: value,
        line: line && line > 0 ? line : undefined,
        column,
        page: page && page > 0 ? page : undefined,
      };
  }
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return { kind: "blocked" };
      segments.pop();
    } else segments.push(segment);
  }
  const normalized = (value.startsWith("/") && !root ? "/" : "") + segments.join("/");
  if (!normalized) return { kind: "blocked" };
  return {
    kind: "file",
    path: normalized,
    line: line && line > 0 ? line : undefined,
    column,
    page: page && page > 0 ? page : undefined,
  };
}
export function fileLinkReference(
  target: Extract<ChatLinkTarget, { kind: "file" | "external-file" }>,
) {
  return (
    target.path +
    (target.line
      ? `:${target.line}${target.column ? `:${target.column}` : ""}`
      : target.page
        ? `#page=${target.page}`
        : "")
  );
}
/** react-markdown normally strips file: links. Only preserve protocols parsed here. */
export function chatUrlTransform(url: string, key: string) {
  if (key === "src")
    return /^(data:image\/(png|jpeg|gif|webp);base64,|file:\/\/|https?:\/\/|asset:|\/|\.\/)/i.test(
      url,
    ) || !url.includes(":")
      ? url
      : "";
  return parseChatLink(url).kind === "blocked" ? "" : url;
}
