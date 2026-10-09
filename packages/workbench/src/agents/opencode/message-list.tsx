"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { memo, useEffect, useMemo, useState } from "react";
import { useWorkbenchI18n as useI18n } from "../../i18n";
import { ChatImage } from "../chat/chat-image";
import { UserFileMessage } from "../chat/user-file-message";
import { stripWriterContext } from "../context";
import { splitEditorSelectionMessage } from "../selection-context";
import { ChevronRightIcon } from "./icons";
import { MarkdownText } from "./markdown-text";
import { AskUserQuestionDisplay } from "./question-wizard";
import { stripSearchFallbackHint } from "./search-fallback";
import { ToolDisplay } from "./tool-display";
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "./types";

export const MessageList = memo(function MessageList({
  messages,
  getPartsForMessage,
  onFileClick,
  onAnswer,
}: {
  messages: Message[];
  getPartsForMessage: (messageId: string) => Part[];
  onFileClick?: (path: string) => void;
  onAnswer?: (questionID: string, answers: string[][]) => void;
}) {
  const { t } = useI18n();
  const turns = useMemo(() => {
    const result: { user: Message; assistantMessages: Message[]; assistantParts: Part[] }[] = [];
    let currentTurn: {
      user: Message;
      assistantMessages: Message[];
      assistantParts: Part[];
    } | null = null;

    for (const msg of messages) {
      if (msg.role === "user") {
        if (currentTurn) result.push(currentTurn);
        currentTurn = { user: msg, assistantMessages: [], assistantParts: [] };
      } else if (msg.role === "assistant" && currentTurn) {
        currentTurn.assistantMessages.push(msg);
        const parts = getPartsForMessage(msg.id);
        currentTurn.assistantParts.push(...parts);
      }
    }
    if (currentTurn) result.push(currentTurn);
    return result;
  }, [messages, getPartsForMessage]);

  const [turnsParent] = useAutoAnimate({ duration: 200 });

  if (messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-xs">
        <p>{t("opencode.sendAMessageToGetStarted")}</p>
      </div>
    );
  }

  return (
    <div ref={turnsParent} className="space-y-6">
      {turns.map((turn, index) => {
        const userParts = getPartsForMessage(turn.user.id);
        const userText = stripSearchFallbackHint(
          userParts.find((p): p is TextPart => p.type === "text")?.text || "",
        );
        const userImages = userParts.filter(
          (p): p is FilePart =>
            p.type === "file" &&
            "mime" in p &&
            typeof p.mime === "string" &&
            p.mime.startsWith("image/"),
        );
        const isLastTurn = index === turns.length - 1;

        const lastAssistant = turn.assistantMessages[turn.assistantMessages.length - 1];
        const endTime =
          lastAssistant?.role === "assistant"
            ? (lastAssistant as AssistantMessage).time?.completed
            : undefined;

        return (
          <MessageTurn
            key={turn.user.id}
            userText={userText}
            userImages={userImages}
            assistantParts={turn.assistantParts}
            onFileClick={onFileClick}
            startTime={turn.user.time?.created}
            endTime={endTime}
            onAnswer={isLastTurn ? onAnswer : undefined}
          />
        );
      })}
    </div>
  );
});

function MessageTurn({
  userText,
  userImages,
  assistantParts,
  onFileClick,
  startTime,
  endTime,
  onAnswer,
}: {
  userText: string;
  userImages?: FilePart[];
  assistantParts: Part[];
  onFileClick?: (path: string) => void;
  startTime?: number;
  endTime?: number;
  onAnswer?: (questionID: string, answers: string[][]) => void;
}) {
  const { t } = useI18n();
  const [stepsParent] = useAutoAnimate({ duration: 150 });
  const selectionMessage = useMemo(
    () => splitEditorSelectionMessage(stripWriterContext(userText)),
    [userText],
  );
  const displayText = selectionMessage?.instruction ?? stripWriterContext(userText);
  const [now, setNow] = useState(() => Date.now());

  // Deduplicate parts
  const dedupedParts = useMemo(() => {
    const seen = new Set<string>();
    return assistantParts.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [assistantParts]);

  // Build chronological list: all parts inline (including questions)
  const steps = useMemo(() => {
    const chronologicalSteps: (Part | { type: "reasoning-group"; parts: ReasoningPart[] })[] = [];
    let currentReasoningGroup: ReasoningPart[] = [];

    dedupedParts.forEach((part) => {
      if (part.type === "reasoning") {
        currentReasoningGroup.push(part as ReasoningPart);
      } else {
        if (currentReasoningGroup.length > 0) {
          chronologicalSteps.push({ type: "reasoning-group", parts: [...currentReasoningGroup] });
          currentReasoningGroup = [];
        }
        chronologicalSteps.push(part);
      }
    });

    if (currentReasoningGroup.length > 0) {
      chronologicalSteps.push({ type: "reasoning-group", parts: [...currentReasoningGroup] });
    }

    return chronologicalSteps;
  }, [dedupedParts]);

  // Update timer for in-progress messages
  useEffect(() => {
    if (endTime || !startTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endTime, startTime]);

  const elapsedTime = useMemo(() => {
    if (!startTime) return null;
    const end = endTime || now;
    const elapsed = Math.round((end - startTime) / 1000);
    return `${elapsed}s`;
  }, [startTime, endTime, now]);

  return (
    <div className="space-y-3">
      {/* User message */}
      <div className="border-l-4 border-accent bg-background px-4 py-3">
        {userImages && userImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {userImages.map((img) => (
              <ChatImage
                key={img.id}
                url={img.url}
                name={img.filename || t("opencode.imageAttachment")}
              />
            ))}
          </div>
        )}
        {displayText && (
          <p className="text-[13px] font-mono leading-relaxed whitespace-pre-wrap break-words text-foreground">
            <UserFileMessage text={displayText} onFileClick={onFileClick} />
          </p>
        )}
        {selectionMessage && (
          <details className="mt-2 text-xs text-muted">
            <summary className="cursor-pointer break-words">
              {t("opencode.quotedPathShowTheText", { path: selectionMessage.path })}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <MarkdownText text={selectionMessage.reference} />
            </div>
          </details>
        )}
      </div>

      {/* Elapsed time badge */}
      {elapsedTime && (
        <div className="text-[10px] text-muted-foreground font-mono">{elapsedTime}</div>
      )}

      {/* All steps rendered chronologically */}
      {steps.length > 0 && (
        <div ref={stepsParent} className="space-y-1.5 pl-2 border-l border-surface-secondary ml-1">
          {steps.map((step) => {
            // Reasoning Group
            if ("type" in step && step.type === "reasoning-group") {
              const parts = (step as { parts: ReasoningPart[] }).parts;
              return (
                <ReasoningDisplay
                  key={`reasoning-${parts.map((part) => part.id).join("-")}`}
                  parts={parts}
                />
              );
            }

            const p = step as Part;

            // AskUserQuestion — render inline at its chronological position
            if (p.type === "tool") {
              const toolPart = p as ToolPart;
              const toolName = toolPart.tool.toLowerCase();
              if (toolName === "question" || toolName === "askuserquestion") {
                return <AskUserQuestionDisplay key={p.id} part={toolPart} onAnswer={onAnswer} />;
              }
              return <ToolDisplay key={p.id} part={toolPart} onFileClick={onFileClick} />;
            }

            if (p.type === "file" && "mime" in p && p.mime?.startsWith("image/"))
              return <ChatImage key={p.id} url={p.url} name={p.filename || t("opencode.image")} />;

            // Text Part — rendered as markdown
            if (p.type === "text") {
              return (
                <div key={p.id} className="text-[13px] leading-relaxed text-foreground-secondary">
                  <MarkdownText text={(p as TextPart).text} onFileClick={onFileClick} />
                </div>
              );
            }

            return null;
          })}
        </div>
      )}
    </div>
  );
}

function ReasoningDisplay({ parts }: { parts: ReasoningPart[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const combinedText = parts.map((p) => p.text).join("\n\n");
  const preview = combinedText.slice(0, 100);
  const needsExpand = combinedText.length > 100;

  return (
    <div className="text-xs border border-border bg-accent-hover p-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-muted hover:text-foreground-secondary w-full text-left"
      >
        <ChevronRightIcon
          className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="font-medium">{t("opencode.thinking")}</span>
        {!expanded && needsExpand && (
          <span className="text-muted-foreground truncate flex-1">{preview}...</span>
        )}
      </button>
      {expanded && <div className="mt-2 text-muted whitespace-pre-wrap">{combinedText}</div>}
    </div>
  );
}
