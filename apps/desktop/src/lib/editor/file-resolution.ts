export type IndexedFileNode = {
  path: string;
  type: "file" | "directory";
  children?: IndexedFileNode[];
};
const fallbackExcluded = new Set([
  ".writer",
  ".lmms_lab_writer",
  ".git",
  "node_modules",
  "build",
  "dist",
  "out",
  "tmp",
  "drafts",
  "backup",
  "backups",
]);
export function buildFileIndex(nodes: IndexedFileNode[]) {
  const exact = new Set<string>(),
    byBasename = new Map<string, string[]>();
  const visit = (nodes: IndexedFileNode[]) => {
    for (const node of nodes) {
      if (node.type === "file") {
        exact.add(node.path);
        if (
          node.path
            .split("/")
            .slice(0, -1)
            .some((part) => fallbackExcluded.has(part))
        )
          continue;
        const name = node.path.split("/").pop() || node.path;
        byBasename.set(name, [...(byBasename.get(name) || []), node.path]);
      } else if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return { exact, byBasename };
}
export type FileIndex = ReturnType<typeof buildFileIndex>;
/** Exact project-relative paths always win. Only genuinely ambiguous shorthand is rejected. */
export function resolveFileReference(
  path: string,
  index: FileIndex,
  preferred: string[] = [],
): string {
  if (index.exact.has(path) || path.includes("/")) return path;
  const matches = index.byBasename.get(path) || [];
  const chosen = preferred.find((candidate) => matches.includes(candidate));
  if (chosen) return chosen;
  if (matches.length > 1)
    throw new Error(`“${path}”对应多个文件，请指定项目相对路径：${matches.join("、")}`);
  return matches[0] || path;
}
