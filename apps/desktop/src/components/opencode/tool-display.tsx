"use client";

import { useMemo, useState } from "react";
import { ChatImage } from "@/components/chat/chat-image";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/lib/i18n";
import type { ToolPart } from "@/lib/opencode/types";
import { getToolInfo } from "@/lib/opencode/types";
import { ChevronIcon, ToolIcon } from "./icons";
import { parseTasks, TasksDisplay } from "./tasks-display";
import { formatValue } from "./utils";

export function ToolDisplay({
  part,
  onFileClick,
}: {
  part: ToolPart;
  onFileClick?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const info = getToolInfo(part.tool, part.state.input);
  const isRunning = part.state.status === "running";
  const isError = part.state.status === "error";
  const clickablePath = info.filePath ?? info.subtitle;

  const isClickableFile =
    onFileClick &&
    clickablePath &&
    /\.(tex|bib|cls|sty|txt|md|json|yaml|yml|py|js|ts|tsx|css|html|pdf|log|aux|gz|xdv|fdb_latexmk|synctex)$/i.test(
      clickablePath,
    );
  const images =
    part.state.status === "completed"
      ? (part.state.attachments ?? []).filter((file) => file.mime.startsWith("image/"))
      : [];
  const output = (part.state as { output?: string }).output;
  // Always expand if it's a task tool to show the UI
  const isTaskTool = ["todowrite", "todocreate", "todolist", "todoread", "todoupdate"].includes(
    part.tool.toLowerCase(),
  );

  // Try to parse tasks from input or output
  const tasksFromInput = isTaskTool ? parseTasks(part.state.input) : null;
  // Output might be a stringified JSON
  const tasksFromOutput = useMemo(() => {
    if (!isTaskTool || !output) return null;
    try {
      const parsed = JSON.parse(output);
      return parseTasks(parsed);
    } catch {
      return null;
    }
  }, [isTaskTool, output]);

  const tasksToDisplay = tasksFromOutput || tasksFromInput;

  // If we have tasks to display, force "hasDetails" to true to allow expansion (or auto-expand)
  const hasDetails =
    Object.keys(part.state.input).length > 0 || output || tasksToDisplay || images.length > 0;

  const diffStats = useMemo(() => {
    if (output && (part.tool === "write" || part.tool === "edit")) {
      const addMatch = output.match(/\+(\d+)/);
      const delMatch = output.match(/-(\d+)/);
      return {
        added: addMatch?.[1] ? parseInt(addMatch[1], 10) : null,
        deleted: delMatch?.[1] ? parseInt(delMatch[1], 10) : null,
      };
    }
    return null;
  }, [output, part.tool]);

  const toggleExpanded = () => {
    if (hasDetails) {
      setExpanded((value) => !value);
    }
  };

  return (
    <div
      className={`text-[13px] bg-accent-hover hover:bg-surface-secondary transition-colors ${isError ? "bg-red-50" : ""}`}
    >
      <div className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
        {isRunning ? <Spinner className="size-4 flex-shrink-0" /> : <ToolIcon tool={part.tool} />}
        {isClickableFile ? (
          <button
            type="button"
            onClick={() => {
              if (clickablePath) {
                onFileClick?.(clickablePath);
              }
            }}
            className="text-left text-foreground-secondary hover:text-foreground hover:underline truncate cursor-pointer flex-1"
          >
            {info.subtitle || info.title}
          </button>
        ) : hasDetails ? (
          <button
            type="button"
            onClick={toggleExpanded}
            className="text-left text-foreground-secondary hover:text-foreground truncate cursor-pointer flex-1"
            aria-expanded={expanded}
          >
            {info.subtitle || info.title}
          </button>
        ) : (
          <span className="text-foreground-secondary truncate flex-1">
            {info.subtitle || info.title}
          </span>
        )}
        {diffStats && (diffStats.added || diffStats.deleted) && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0">
            {diffStats.added && <span className="text-green-600">+{diffStats.added}</span>}
            {diffStats.deleted && <span className="text-red-500">-{diffStats.deleted}</span>}
          </span>
        )}
        {hasDetails && (
          <button
            type="button"
            onClick={toggleExpanded}
            className="flex-shrink-0 text-muted-foreground"
            aria-label={
              expanded ? t("opencode.collapseToolDetails") : t("opencode.expandToolDetails")
            }
            aria-expanded={expanded}
          >
            <ChevronIcon
              className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border bg-background">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 p-3">
              {images.map((image) => (
                <ChatImage
                  key={image.id || image.url}
                  url={image.url}
                  name={image.filename || t("opencode.toolImage")}
                />
              ))}
            </div>
          )}
          {/* Special Task Display */}
          {tasksToDisplay && (
            <div className="px-3 py-2">
              <TasksDisplay tasks={tasksToDisplay} />
            </div>
          )}

          {/* Standard Input/Output fallback if no special display or if debugging */}
          {!tasksToDisplay && Object.keys(part.state.input).length > 0 && (
            <div className="px-3 py-2 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                {t("opencode.input")}
              </div>
              {Object.entries(part.state.input).map(([key, value]) => (
                <div key={key} className="font-mono text-xs">
                  <span className="text-accent font-medium">{key}</span>
                  <span className="text-muted-foreground">: </span>
                  <span className="text-foreground-secondary whitespace-pre-wrap break-all">
                    {formatValue(value)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!tasksToDisplay && output && (
            <div className="px-3 py-2 border-t border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                {t("opencode.output")}
              </div>
              <pre className="text-xs text-muted whitespace-pre-wrap break-all font-mono max-h-48 overflow-auto">
                {output.length > 2000 ? `${output.slice(0, 2000)}...` : output}
              </pre>
            </div>
          )}
        </div>
      )}

      {isError && (
        <div className="border-t border-red-200 px-3 py-2 bg-red-50">
          <p className="text-xs text-red-600">{(part.state as { error: string }).error}</p>
        </div>
      )}
    </div>
  );
}
