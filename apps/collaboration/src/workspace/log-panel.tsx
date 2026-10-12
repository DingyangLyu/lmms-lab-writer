/** Errors, warnings and the full TeX log below the editor, where the desktop has its terminal. */
import { texErrorHint, workbenchI18n } from "@lmms-lab/workbench";
import { XIcon } from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import type { BuildState } from "./build";
import type { WorkspaceContext } from "./context";
import { AskAiToFix, BuildSummary, ChineseHint } from "./pdf-pane";

/** The server words two messages itself (in Chinese); the rest are TeX's own. */
export function issueText(message: string) {
  const failed = /^编译失败（latexmk 退出码 (-?\d+)），请查看日志$/.exec(message);
  if (failed) return workbenchI18n.t("build.failedExit", { code: failed[1] ?? "" });
  if (message === "编译超时，已停止") return workbenchI18n.t("build.timedOut");
  return message;
}

export function LogPanel({
  ws,
  b,
  onClose,
}: {
  ws: WorkspaceContext;
  b: BuildState;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { build } = b;
  const errors = build?.issues.filter((i) => i.level === "error") ?? [],
    warnings = build?.issues.filter((i) => i.level === "warning") ?? [];
  return (
    <section aria-label={t("shell.buildLog")} className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3">
        <strong className="font-medium">{t("shell.buildLog")}</strong>
        <span className="min-w-0 flex-1 truncate text-muted">
          <BuildSummary b={b} />
          {!!build?.issues.length &&
            ` · ${t("build.issues", { errors: errors.length, warnings: warnings.length })}`}
        </span>
        <AskAiToFix ws={ws} b={b} />
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="p-1 text-muted hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ChineseHint b={b} />
        {[...errors, ...warnings].map((issue, i) => (
          <button
            type="button"
            // biome-ignore lint/suspicious/noArrayIndexKey: Issues of one immutable build.
            key={i}
            disabled={!issue.file || !issue.line}
            onClick={() => issue.file && issue.line && b.openLocation(issue.file, issue.line)}
            className="flex w-full items-start gap-2 border-b border-border px-3 py-1.5 text-left hover:bg-accent-hover disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span
              className={`shrink-0 font-medium ${issue.level === "error" ? "text-red-600" : "text-amber-600"}`}
            >
              {issue.level === "error" ? "✕" : "!"}
            </span>
            {issue.file && issue.line && (
              <span className="shrink-0 text-muted">
                {issue.file}:{issue.line}
              </span>
            )}
            <span className="min-w-0 break-words">
              {issueText(issue.message)}
              {texErrorHint(issue.message) && (
                <span className="mt-0.5 block text-muted">{texErrorHint(issue.message)}</span>
              )}
            </span>
          </button>
        ))}
        {build ? (
          <pre className="whitespace-pre-wrap break-all p-3 text-[11px] leading-relaxed text-muted">
            {build.log}
          </pre>
        ) : (
          <p className="p-3 text-muted">{t("build.none")}</p>
        )}
      </div>
    </section>
  );
}
