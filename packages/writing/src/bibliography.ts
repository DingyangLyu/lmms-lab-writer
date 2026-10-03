export type BibEntry = {
  type: string;
  key: string;
  fields: Record<string, string>;
  raw: string;
  from: number;
  to: number;
};
export type BibDocument = {
  entries: BibEntry[];
  errors: string[];
  directives: { name: string; raw: string }[];
};
const decode = (s: string) => s.replace(/[{}]/g, "").replace(/\\(?:&|_|%)/g, (s) => s.slice(1));
export const normalizeDoi = (input: string) => {
  const value = input.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
  if (
    !/^10\.\d{4,9}\/\S+$/i.test(value) ||
    /[<>"]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) <= 32)
  )
    throw new Error("请输入有效 DOI，例如 10.1038/nature14539。");
  return value.toLowerCase();
};

/** Parse spans without rewriting unrelated BibTeX, comments, macros or formatting. */
export function parseBib(source: string): BibDocument {
  const entries: BibEntry[] = [],
    errors: string[] = [];
  const directives: BibDocument["directives"] = [];
  const head = /@([A-Za-z]+)\s*([{(])/g;
  while (true) {
    const m = head.exec(source);
    if (!m) break;
    if (/(?<!\\)%/.test(source.slice(source.lastIndexOf("\n", m.index) + 1, m.index))) continue;
    const type = (m[1] ?? "").toLowerCase(),
      open = m[2];
    let at = head.lastIndex,
      depth = 1,
      braces = open === "{" ? 1 : 0,
      quote = false,
      escaped = false;
    for (; at < source.length; at++) {
      const c = source[at];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      const outer = open === "{" ? braces === 1 : braces === 0;
      if (c === '"' && outer) quote = !quote;
      if (quote) continue;
      if (c === "{") braces++;
      else if (c === "}") {
        braces--;
        if (open === "{" && braces === 0) {
          depth = 0;
          break;
        }
      } else if (open === "(" && braces === 0) {
        if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
    }
    if (depth !== 0) {
      errors.push(`位置 ${m.index + 1} 的 @${type} 未闭合`);
      break;
    }
    const end = at + 1;
    head.lastIndex = end;
    if (["comment", "preamble", "string"].includes(type)) {
      if (type === "string") {
        const name = /^\s*([\w-]+)\s*=/.exec(source.slice(m.index + m[0].length, at))?.[1];
        if (name) directives.push({ name: name.toLowerCase(), raw: source.slice(m.index, end) });
        else errors.push(`位置 ${m.index + 1} 的 @string 无效`);
      }
      if (type === "preamble")
        errors.push("含 @preamble，请在原始 BibTeX 文件中手动合并，避免改变编译设置");
      continue;
    }
    const body = source.slice(m.index + m[0].length, at);
    const keyMatch = /^\s*([^,\s]+)\s*,/.exec(body);
    if (!keyMatch?.[1]) {
      errors.push(`位置 ${m.index + 1} 缺少引用键`);
      continue;
    }
    const fields: Record<string, string> = {};
    let cursor = keyMatch[0].length;
    while (cursor < body.length) {
      const field = /^\s*,?\s*([\w-]+)\s*=\s*/.exec(body.slice(cursor));
      if (!field?.[1]) break;
      cursor += field[0].length;
      const start = cursor;
      let braces = 0,
        quoted = false,
        valueEscaped = false;
      while (cursor < body.length) {
        const c = body[cursor];
        if (valueEscaped) {
          valueEscaped = false;
          cursor++;
          continue;
        }
        if (c === "\\") {
          valueEscaped = true;
          cursor++;
          continue;
        }
        if (c === "{" && !quoted) braces++;
        else if (c === "}" && !quoted) braces--;
        else if (c === '"' && braces === 0) quoted = !quoted;
        if (c === "," && braces === 0 && !quoted) break;
        cursor++;
      }
      let value = body.slice(start, cursor).trim();
      if (
        (value.startsWith("{") && value.endsWith("}")) ||
        (value.startsWith('"') && value.endsWith('"'))
      )
        value = value.slice(1, -1);
      fields[field[1].toLowerCase()] = value;
      cursor++;
    }
    entries.push({
      type,
      key: keyMatch[1],
      fields,
      raw: source.slice(m.index, end),
      from: m.index,
      to: end,
    });
  }
  return { entries, errors, directives };
}
export function bibliographyIdentity(entry: BibEntry) {
  try {
    if (entry.fields.doi) return `doi:${normalizeDoi(decode(entry.fields.doi))}`;
  } catch {
    /* Report separately in UI. */
  }
  const title = decode(entry.fields.title ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return title ? `title:${title}:${entry.fields.year ?? ""}` : `key:${entry.key}`;
}
export function importBibliography(existing: string, incoming: string) {
  const old = parseBib(existing),
    next = parseBib(incoming);
  if (old.errors.length || next.errors.length)
    throw new Error([...old.errors, ...next.errors].join("；"));
  const directives: string[] = [];
  for (const macro of next.directives) {
    const previous = old.directives.find((d) => d.name === macro.name);
    if (previous && previous.raw.replace(/\s+/g, "") !== macro.raw.replace(/\s+/g, ""))
      throw new Error(`BibTeX 字符串宏 ${macro.name} 定义冲突，请手动核对`);
    if (!previous) directives.push(macro.raw);
  }
  const keys = new Set(old.entries.map((e) => e.key));
  const identities = new Set(old.entries.map(bibliographyIdentity));
  const added: string[] = [],
    skipped: string[] = [],
    renamed: Record<string, string> = {};
  for (const entry of next.entries) {
    const identity = bibliographyIdentity(entry);
    if (identities.has(identity)) {
      skipped.push(entry.key);
      continue;
    }
    let key = entry.key,
      n = 2;
    while (keys.has(key)) key = `${entry.key}_${n++}`;
    const raw = entry.raw.replace(
      /^(@[A-Za-z]+\s*[{(]\s*)[^,\s]+/,
      (_all, prefix: string) => prefix + key,
    );
    if (key !== entry.key) renamed[entry.key] = key;
    added.push(raw);
    keys.add(key);
    identities.add(identity);
  }
  return {
    content: added.length
      ? `${existing.trimEnd()}\n\n${[...directives, ...added].join("\n\n")}\n`
      : existing,
    added: added.length,
    skipped,
    renamed,
  };
}
export type Citation = { key: string; from: number; to: number; line: number };
export function citations(source: string): Citation[] {
  // Blank comments, keeping offsets. Escaped percent is not a comment.
  const clean = source.replace(/(?<!\\)%[^\n]*/g, (s) => " ".repeat(s.length));
  const re = /\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]+)\}/g;
  const out: Citation[] = [];
  for (const match of clean.matchAll(re)) {
    const group = match[1] ?? "",
      offset = match.index + match[0].lastIndexOf("{") + 1;
    for (const keyMatch of group.matchAll(/[^,\s]+/g)) {
      if (keyMatch[0] === "*") continue;
      const from = offset + keyMatch.index;
      out.push({
        key: keyMatch[0],
        from,
        to: from + keyMatch[0].length,
        line: source.slice(0, from).split("\n").length,
      });
    }
  }
  return out;
}
export function renameCitationKey(source: string, from: string, to: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/.test(to))
    throw new Error("引用键只能含英文、数字和 _ . : + / -");
  let output = source;
  for (const c of citations(source)
    .filter((c) => c.key === from)
    .reverse())
    output = output.slice(0, c.from) + to + output.slice(c.to);
  return output;
}
export const displayBib = (entry: BibEntry) => ({
  title: decode(entry.fields.title || entry.key),
  authors: decode(entry.fields.author || ""),
  year: entry.fields.year || "",
  doi: entry.fields.doi || "",
});
export function renameBibKey(source: string, from: string, to: string) {
  renameCitationKey("", from, to);
  const parsed = parseBib(source);
  if (parsed.errors.length) throw new Error(parsed.errors.join("；"));
  if (parsed.entries.some((e) => e.key === to && e.key !== from))
    throw new Error("目标引用键已存在");
  let result = source;
  for (const entry of parsed.entries.filter((e) => e.key === from).reverse())
    result =
      result.slice(0, entry.from) +
      entry.raw.replace(/^(@[A-Za-z]+\s*[{(]\s*)[^,\s]+/, (_all, prefix: string) => prefix + to) +
      result.slice(entry.to);
  return result.replace(
    /(\b(?:crossref|xref)\s*=\s*[{"])([^}"]+)([}"])/gi,
    (all, prefix: string, key: string, end: string) =>
      key === from ? `${prefix}${to}${end}` : all,
  );
}
