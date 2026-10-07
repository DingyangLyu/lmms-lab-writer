import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Build, Comment, Member, Proposal, Snapshot, SourceFile } from "../shared/api";

// pdf.js needs a browser; the pane is rendered without a PDF.
vi.mock("./pdf-viewer", () => ({ PdfViewer: () => null }));
vi.stubGlobal("location", new URL("http://127.0.0.1:8787/"));
/** Server rendering separates adjacent text with comments. */
const html = (node: Parameters<typeof renderToString>[0]) =>
  renderToString(node).replaceAll("<!-- -->", "");
const { App } = await import("./app");
const { BibliographyTab } = await import("./workspace/bibliography-tab");
const { BuildPane } = await import("./workspace/build");
const { CommentsTab } = await import("./workspace/comments-tab");
const { HistoryTab } = await import("./workspace/history-tab");
const { MembersTab } = await import("./workspace/members-tab");
const { ReviewTab } = await import("./workspace/review-tab");

import type { WorkspaceContext } from "./workspace/context";

const file = { id: "f1", path: "main.tex", binary: false, revision: 1 };
const ws: WorkspaceContext = {
  prefix: "/projects/p1",
  project: { id: "p1", name: "论文", role: "owner" },
  user: { id: "u1", name: "lab", admin: true, mustChange: false },
  role: "owner",
  canEdit: true,
  canComment: true,
  busy: false,
  run: () => {},
  reload: async () => {},
  notify: () => {},
  report: () => {},
  editor: { current: null },
  file,
  files: [file],
  openFile: () => {},
  status: "saved",
};
const comment: Comment = {
  id: "c1",
  file: "f1",
  author: "u1",
  authorName: "lab",
  quote: "引文",
  start: "",
  end: "",
  body: "请核对",
  resolved: false,
  created: 1,
  updated: 1,
  replies: [
    { id: "r1", comment: "c1", author: "u1", authorName: "lab", body: "已核对", created: 2 },
  ],
};
const proposal: Proposal = {
  id: "p",
  project: "p1",
  file: "f1",
  author: "u1",
  base: "a\n",
  proposed: "b\n",
  hunks: [{ id: "0", from: 0, to: 2, before: "a\n", after: "b\n", status: "pending" }],
  revision: 1,
  created: 1,
};
const snapshot: Snapshot = { id: "s", label: "投稿前", author: "u1", created: 1, manual: false };
const member: Member = { id: "u2", username: "coauthor", role: "editor" };
const sources: SourceFile[] = [
  { id: "b", path: "refs.bib", content: "@article{k1,title={Paper},author={A}}", revision: 1 },
  { id: "f1", path: "main.tex", content: "\\cite{k1}", revision: 1 },
];
const build: Build = {
  id: "b1",
  main: "main.tex",
  engine: "pdflatex",
  status: "failed",
  issues: [{ level: "error", file: "main.tex", line: 4, message: "Undefined control sequence." }],
  log: "log",
  pdf: false,
  duration: 1200,
  created: 1,
  author: "u1",
};

describe("client panels render", () => {
  it("renders the loading shell", () => {
    expect(html(<App />)).toContain("正在载入");
  });
  it("renders every inspector tab with data", () => {
    const rendered = [
      html(
        <CommentsTab
          ws={ws}
          comments={[comment]}
          selection={{ quote: "选中", start: "", end: "" }}
          setSelection={() => {}}
          draft=""
          setDraft={() => {}}
        />,
      ),
      html(<ReviewTab ws={ws} proposals={[proposal]} />),
      html(<HistoryTab ws={ws} snapshots={[snapshot]} />),
      html(<MembersTab ws={ws} members={[member]} onDeleted={() => {}} />),
      html(<BibliographyTab ws={ws} sources={sources} refreshSources={async () => sources} />),
    ].join("");
    for (const text of [
      "请核对",
      "已核对",
      "待审阅",
      "投稿前",
      "自动",
      "coauthor",
      "Paper",
      "1 处引用",
    ])
      expect(rendered).toContain(text);
  });
  it("renders build results with clickable issues", () => {
    const pane = html(
      <BuildPane
        prefix="/projects/p1"
        b={{
          build,
          compiling: false,
          open: true,
          setOpen: () => {},
          texFiles: [file],
          chosenMain: "main.tex",
          setMain: () => {},
          chosenEngine: "pdflatex",
          setEngine: () => {},
          highlight: null,
          compile: () => {},
          showCursorInPdf: () => {},
          showPdfInSource: () => {},
          openLocation: () => {},
        }}
      />,
    );
    expect(pane).toContain("编译有错误");
    expect(pane).toContain("main.tex:4");
    expect(pane).toContain("没有生成 PDF");
  });
});
