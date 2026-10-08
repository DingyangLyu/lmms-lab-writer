"use client";

import {
  BrainIcon,
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { open } from "@tauri-apps/plugin-shell";
import { memo, useId, useState } from "react";
import { type CodexItem, textForCodexItem } from "@/lib/codex/events";
import { i18n, useI18n } from "@/lib/i18n";

type Props = {
  item: CodexItem;
  directory?: string;
  onFileClick?: (path: string) => void;
};

type ActivityKind = "command" | "search" | "change" | "tool" | "thinking";

const APPEARANCE: Record<ActivityKind, { border: string; icon: string; surface: string }> = {
  command: {
    border: "border-l-sky-400 dark:border-l-sky-500",
    icon: "text-sky-700 dark:text-sky-300",
    surface: "bg-sky-50/35 dark:bg-sky-950/15",
  },
  search: {
    border: "border-l-teal-400 dark:border-l-teal-500",
    icon: "text-teal-700 dark:text-teal-300",
    surface: "bg-teal-50/35 dark:bg-teal-950/15",
  },
  change: {
    border: "border-l-emerald-400 dark:border-l-emerald-500",
    icon: "text-emerald-700 dark:text-emerald-300",
    surface: "bg-emerald-50/35 dark:bg-emerald-950/15",
  },
  tool: {
    border: "border-l-indigo-400 dark:border-l-indigo-500",
    icon: "text-indigo-700 dark:text-indigo-300",
    surface: "bg-indigo-50/35 dark:bg-indigo-950/15",
  },
  thinking: {
    border: "border-l-violet-400 dark:border-l-violet-500",
    icon: "text-violet-700 dark:text-violet-300",
    surface: "bg-violet-50/35 dark:bg-violet-950/15",
  },
};

function kindForItem(item: CodexItem): ActivityKind {
  switch (item.type) {
    case "commandExecution":
      return "command";
    case "webSearch":
      return "search";
    case "fileChange":
      return "change";
    case "reasoning":
      return "thinking";
    default:
      return "tool";
  }
}

function relativePath(path: string, directory?: string): string {
  if (!directory) return path.split("/").pop() || path;
  const root = directory.replace(/\/$/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.split("/").pop() || path;
}

function commandPreview(command?: string): string {
  if (!command) return i18n.t("activity.runACommand");
  return command
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/, "")
    .replace(/^["']/, "");
}

function previewForItem(item: CodexItem, directory?: string): string {
  switch (item.type) {
    case "commandExecution":
      return commandPreview(item.command);
    case "webSearch":
      return (
        item.query ??
        item.action?.query ??
        item.action?.queries?.join(" · ") ??
        item.action?.url ??
        i18n.t("activity.web")
      );
    case "fileChange": {
      const paths = item.changes?.map((change) => relativePath(change.path, directory)) ?? [];
      return paths.length ? paths.join(" · ") : i18n.t("activity.projectFiles");
    }
    case "reasoning":
      return (
        textForCodexItem(item).replace(/\s+/g, " ").trim() || i18n.t("activity.analysingTheTask")
      );
    case "mcpToolCall":
      return [item.server, item.tool].filter(Boolean).join(" / ") || i18n.t("activity.useATool");
    default:
      return item.type;
  }
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const className = "size-4 shrink-0";
  switch (kind) {
    case "command":
      return <TerminalWindowIcon className={className} aria-hidden="true" />;
    case "search":
      return <MagnifyingGlassIcon className={className} aria-hidden="true" />;
    case "change":
      return <FileTextIcon className={className} aria-hidden="true" />;
    case "thinking":
      return <BrainIcon className={className} aria-hidden="true" />;
    default:
      return <WrenchIcon className={className} aria-hidden="true" />;
  }
}

function DetailBlock({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-medium tracking-wide text-muted">{label}</div>
      <pre className="max-h-56 overflow-auto bg-background/80 px-2.5 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-foreground-secondary select-text">
        {value}
      </pre>
    </div>
  );
}

function CodexActivityCardInner({ item, directory, onFileClick }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const kind = kindForItem(item);
  const appearance = APPEARANCE[kind];
  const running = item.lifecycleStatus
    ? item.lifecycleStatus === "inProgress"
    : item.status === "inProgress";
  const failed = ["failed", "error", "declined"].includes(item.status ?? "") || Boolean(item.error);
  const title = {
    command: t("activity.terminal"),
    search: t("activity.search2"),
    change: t("activity.edit"),
    tool: t("activity.tool"),
    thinking: t("activity.thinking2"),
  }[kind];
  const preview = previewForItem(item, directory);
  const reasoningText = kind === "thinking" ? textForCodexItem(item).trim() : "";

  // Codex may not retain reasoning text in saved history. Keep only active cards in that case.
  if (kind === "thinking" && !reasoningText && !running) return null;

  return (
    <div
      className={`relative min-w-0 overflow-hidden border border-l-[3px] border-border ${appearance.border} ${appearance.surface} ${running ? "codex-activity-running" : ""} ${running && kind === "thinking" ? "codex-activity-thinking" : ""}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={t(expanded ? "activity.hideTitleDetails" : "activity.showTitleDetails", {
          title,
        })}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-foreground/[0.035] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground"
      >
        <span className={appearance.icon}>
          <ActivityIcon kind={kind} />
        </span>
        <span className="shrink-0 text-xs font-medium text-foreground">{title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={preview}>
          {preview}
        </span>
        <span
          className={`flex shrink-0 items-center gap-1 text-[10px] ${failed ? "text-red-600 dark:text-red-400" : running ? "text-amber-700 dark:text-amber-300" : "text-muted"}`}
        >
          {failed ? (
            <>
              <WarningCircleIcon className="size-3.5" aria-hidden="true" />
              {t("activity.failed")}
            </>
          ) : running ? (
            <>
              <CircleNotchIcon className="size-3.5 codex-activity-spinner" aria-hidden="true" />
              {kind === "thinking" ? t("activity.thinking") : t("activity.running")}
            </>
          ) : (
            <CheckIcon className="size-3.5" aria-label={t("activity.done")} />
          )}
        </span>
        <CaretDownIcon
          aria-hidden="true"
          className={`codex-activity-chevron size-3.5 shrink-0 text-muted transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      <section
        id={detailId}
        aria-label={t("activity.titleDetails", { title })}
        hidden={!expanded}
        className="codex-activity-detail border-t border-border/70 p-2.5"
      >
        {expanded && (
          <div className="space-y-2.5">
            {kind === "command" && (
              <>
                <DetailBlock label={t("activity.command")} value={item.command} />
                <DetailBlock
                  label={t("activity.output")}
                  value={item.aggregatedOutput ?? undefined}
                />
                {(item.exitCode != null || item.durationMs != null) && (
                  <p className="text-[10px] text-muted">
                    {item.exitCode != null && t("activity.exitCodeCode", { code: item.exitCode })}
                    {item.exitCode != null && item.durationMs != null && " · "}
                    {item.durationMs != null &&
                      t("activity.tookSecondsS", { seconds: (item.durationMs / 1000).toFixed(1) })}
                  </p>
                )}
              </>
            )}
            {kind === "search" && (
              <>
                <DetailBlock
                  label={t("activity.search")}
                  value={
                    item.query ??
                    item.action?.query ??
                    item.action?.queries?.join("\n") ??
                    item.action?.url ??
                    undefined
                  }
                />
                {item.results?.map((result) => (
                  <div
                    key={
                      result.ref_id ??
                      `${result.url ?? ""}|${result.title ?? ""}|${result.snippet ?? ""}`
                    }
                    className="min-w-0 border-l-2 border-teal-200 pl-2 dark:border-teal-800"
                  >
                    {result.url ? (
                      <button
                        type="button"
                        onClick={() => void open(result.url as string)}
                        className="block max-w-full truncate text-left text-[11px] text-teal-700 hover:underline dark:text-teal-300"
                        title={result.url}
                      >
                        {result.title || result.url}
                      </button>
                    ) : (
                      <div className="text-[11px] text-foreground-secondary">{result.title}</div>
                    )}
                    {result.snippet && (
                      <p className="mt-0.5 line-clamp-3 text-[10px] leading-4 text-muted">
                        {result.snippet}
                      </p>
                    )}
                  </div>
                ))}
              </>
            )}
            {kind === "change" &&
              (item.changes?.map((change) => (
                <div key={change.path} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onFileClick?.(change.path)}
                    className="max-w-full truncate text-left text-[11px] text-emerald-700 hover:underline dark:text-emerald-300"
                    title={change.path}
                  >
                    {relativePath(change.path, directory)}
                    {change.kind
                      ? ` · ${typeof change.kind === "string" ? change.kind : change.kind.type}`
                      : ""}
                  </button>
                  <DetailBlock label={t("activity.changes")} value={change.diff} />
                </div>
              )) ?? (
                <div className="text-[11px] text-muted">{t("activity.projectFilesChanged")}</div>
              ))}
            {kind === "thinking" && (
              <DetailBlock
                label={t("activity.reasoningSummary")}
                value={reasoningText || t("activity.analysing")}
              />
            )}
            {kind === "tool" && (
              <>
                <DetailBlock
                  label={t("activity.tool")}
                  value={[item.server, item.tool].filter(Boolean).join(" / ")}
                />
                <DetailBlock label={t("activity.content")} value={item.text} />
                <DetailBlock
                  label={t("activity.output")}
                  value={item.aggregatedOutput ?? undefined}
                />
              </>
            )}
            <DetailBlock label={t("activity.error")} value={item.error} />
            {running && (
              <div
                className="codex-activity-dots text-[11px] text-amber-700 dark:text-amber-300"
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export const CodexActivityCard = memo(CodexActivityCardInner);
