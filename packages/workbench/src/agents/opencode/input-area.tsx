"use client";

import {
  ArrowUpIcon,
  CaretLeftIcon,
  CaretRightIcon,
  PaperclipIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { workbenchI18n as i18n, useWorkbenchI18n as useI18n } from "../../i18n";
import { AttachmentStrip } from "../chat/attachment-strip";
import { GrowingTextarea } from "../chat/growing-textarea";
import { useChatAttachments } from "../chat/use-chat-attachments";
import { type EditorSelectionContext, selectionRangeLabel } from "../selection-context";
import { ChevronIcon, StopIcon } from "./icons";
import { findSelectedModel, preferredVariant } from "./model-selection";
import type { AttachedFile } from "./panel-types";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

type VariantMap = Record<string, { disabled?: boolean; [key: string]: unknown }>;

type InputModel = {
  id: string;
  name: string;
  options?: { max?: boolean; reasoning?: boolean };
  variants?: VariantMap;
};

type InputProvider = {
  id: string;
  name: string;
  models: InputModel[];
};

type SelectedModelChoice = {
  providerId: string;
  modelId: string;
  variant?: string;
};

const VARIANT_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  fast: "Fast",
};

const VARIANT_ORDER = ["none", "low", "medium", "high", "xhigh", "fast"];

function isVariantEnabled(variants: VariantMap | undefined, variant: string | undefined): boolean {
  if (!variants || !variant) return false;
  return variants[variant]?.disabled !== true;
}

function formatVariantLabel(variant: string): string {
  return VARIANT_LABELS[variant] ?? variant;
}

function getVariantOptions(variants: VariantMap | undefined): SelectOption[] {
  if (!variants) return [];

  const available = Object.entries(variants)
    .filter(([, config]) => config?.disabled !== true)
    .map(([variant]) => variant)
    .sort((a, b) => {
      const aIndex = VARIANT_ORDER.indexOf(a);
      const bIndex = VARIANT_ORDER.indexOf(b);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.localeCompare(b);
    });

  if (available.length === 0) return [];

  return [
    { value: "", label: i18n.t("opencode.effortAuto") },
    ...available.map((variant) => ({
      value: variant,
      label: i18n.t("opencode.effortVariant", { variant: formatVariantLabel(variant) }),
    })),
  ];
}

function useDropdownPosition(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  menuRef: React.RefObject<HTMLDivElement | null>,
) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);

  const openMenu = useCallback(() => {
    setPositioned(false);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPositioned(false);
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open, menuRef, triggerRef, close]);

  // Calculate position before paint, re-runs when open state changes
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();

    let x = triggerRect.left;
    let y = triggerRect.top - menuRect.height - 4; // above trigger

    // Keep within viewport horizontally
    if (x + menuRect.width > window.innerWidth) {
      x = window.innerWidth - menuRect.width - 8;
    }
    x = Math.max(8, x);

    // If not enough space above, position below
    if (y < 8) {
      y = triggerRect.bottom + 4;
    }

    setPos((prev) => {
      if (prev.x === x && prev.y === y) return prev;
      return { x, y };
    });
    setPositioned(true);
  }, [open, triggerRef, menuRef]);

  return { open, pos, positioned, openMenu, close };
}

function CustomSelect({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, pos, positioned, openMenu, close } = useDropdownPosition(triggerRef, menuRef);

  const selectedLabel = options.find((o) => o.value === value)?.label || value;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        className={`flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground transition-colors cursor-pointer ${className || ""}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronIcon className="size-3 text-muted-foreground flex-shrink-0" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[9999] min-w-[160px] max-h-[240px] overflow-y-auto border border-border bg-background shadow-lg rounded-lg py-1"
            style={{ left: pos.x, top: pos.y, visibility: positioned ? "visible" : "hidden" }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  close();
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  opt.value === value
                    ? "bg-surface-secondary text-foreground font-medium"
                    : "text-muted hover:bg-accent-hover hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function GroupedSelect({
  value,
  groups,
  displayLabel,
  onChange,
  className,
}: {
  value: string;
  groups: SelectOptionGroup[];
  displayLabel?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const {
    open,
    pos,
    positioned,
    openMenu: rawOpen,
    close: rawClose,
  } = useDropdownPosition(triggerRef, menuRef);

  const openMenu = useCallback(() => {
    setActiveGroup(null);
    rawOpen();
  }, [rawOpen]);

  const close = useCallback(() => {
    setActiveGroup(null);
    rawClose();
  }, [rawClose]);

  // Find which group currently contains the selected value
  const selectedGroup = useMemo(() => {
    for (const group of groups) {
      if (group.options.some((o) => o.value === value)) return group.label;
    }
    return null;
  }, [value, groups]);

  const selectedLabel = useMemo(() => {
    if (displayLabel) return displayLabel;
    for (const group of groups) {
      const found = group.options.find((o) => o.value === value);
      if (found) return found.label;
    }
    return value;
  }, [value, groups, displayLabel]);

  const currentGroup = activeGroup ? groups.find((g) => g.label === activeGroup) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        className={`flex items-center gap-1 text-xs font-medium text-muted hover:text-foreground transition-colors cursor-pointer ${className || ""}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronIcon className="size-3 text-muted-foreground flex-shrink-0" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[9999] min-w-[180px] max-h-[300px] overflow-y-auto border border-border bg-background shadow-lg rounded-lg py-1"
            style={{ left: pos.x, top: pos.y, visibility: positioned ? "visible" : "hidden" }}
          >
            {currentGroup ? (
              <>
                <button
                  type="button"
                  onClick={() => setActiveGroup(null)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-muted transition-colors border-b border-surface-secondary mb-1"
                >
                  <CaretLeftIcon className="size-3" />
                  <span className="font-medium">{currentGroup.label}</span>
                </button>
                {currentGroup.options.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      close();
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                      opt.value === value
                        ? "bg-surface-secondary text-foreground font-medium"
                        : "text-muted hover:bg-accent-hover hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </>
            ) : (
              groups.map((group) => (
                <button
                  key={group.label}
                  type="button"
                  onClick={() => setActiveGroup(group.label)}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors ${
                    group.label === selectedGroup
                      ? "bg-surface-secondary text-foreground font-medium"
                      : "text-muted hover:bg-accent-hover hover:text-foreground"
                  }`}
                >
                  <span>{group.label}</span>
                  <CaretRightIcon className="size-3 text-muted-foreground" />
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function InputArea({
  directory,
  onAttachmentLoading,
  active = true,
  input,
  setInput,
  attachedFiles,
  setAttachedFiles,
  onSend,
  onAbort,
  isWorking,
  isSending = false,
  deliveryMode = "steer",
  deliveryControls,
  agents,
  providers,
  selectedAgent,
  selectedModel,
  onSelectAgent,
  onSelectModel,
  editorSelection,
  onClearSelection,
}: {
  active?: boolean;
  directory?: string;
  onAttachmentLoading?: (loading: boolean) => void;
  input: string;
  setInput: (v: string) => void;
  attachedFiles: AttachedFile[];
  setAttachedFiles: React.Dispatch<React.SetStateAction<AttachedFile[]>>;
  onSend: () => void;
  onAbort: () => void;
  isWorking: boolean;
  isSending?: boolean;
  deliveryMode?: "steer" | "queue";
  deliveryControls?: React.ReactNode;
  agents: { id: string; name: string; description?: string }[];
  providers: InputProvider[];
  selectedAgent: string | null;
  selectedModel: SelectedModelChoice | null;
  onSelectAgent: (agentId: string | null) => void;
  onSelectModel: (m: SelectedModelChoice | null) => void;
  editorSelection?: EditorSelectionContext | null;
  onClearSelection?: () => void;
}) {
  const { t } = useI18n();
  const attachments = useChatAttachments(
    attachedFiles,
    setAttachedFiles,
    active,
    isSending,
    directory,
  );
  useEffect(
    () => onAttachmentLoading?.(attachments.loading),
    [onAttachmentLoading, attachments.loading],
  );
  const isComposingRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent;
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!attachments.loading) onSend();
    }
  };

  const handleCompositionStart = () => {
    if (compositionEndTimerRef.current) {
      clearTimeout(compositionEndTimerRef.current);
      compositionEndTimerRef.current = null;
    }
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    compositionEndTimerRef.current = setTimeout(() => {
      isComposingRef.current = false;
      compositionEndTimerRef.current = null;
    }, 0);
  };

  useEffect(() => {
    return () => {
      if (compositionEndTimerRef.current) {
        clearTimeout(compositionEndTimerRef.current);
      }
    };
  }, []);

  const _selectedAgentName = useMemo(() => {
    return agents.find((a) => a.id === selectedAgent)?.name || "Agent";
  }, [selectedAgent, agents]);

  let selectedModelInfo = { name: "Model", provider: "", isMax: false };
  let selectedModelRecord: InputModel | undefined;
  const selected = findSelectedModel(providers, selectedModel);
  if (selected) {
    selectedModelRecord = selected.model;
    selectedModelInfo = {
      name: selected.model.name,
      provider: selected.provider.name,
      isMax: selected.model.options?.max ?? false,
    };
  }
  const variantOptions = getVariantOptions(selectedModelRecord?.variants);

  return (
    <fieldset
      aria-label={t("opencode.messageAndAttachments")}
      ref={attachments.areaRef}
      onDragOver={(event) => event.preventDefault()}
      onDrop={attachments.onDrop}
      className="writer-composer-card"
    >
      {deliveryControls}
      {editorSelection && (
        <section
          className="border-b border-border px-3 py-2 text-xs"
          aria-label={t("opencode.quotedEditorSelection")}
        >
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 break-words">
              {t("opencode.quotingPathRanges", {
                path: editorSelection.path,
                ranges: editorSelection.ranges
                  .map(selectionRangeLabel)
                  .join(t("agentsCommon.listSeparator")),
              })}
            </span>
            <button
              type="button"
              onClick={onClearSelection}
              className="shrink-0 px-1 hover:text-accent"
              aria-label={t("opencode.stopQuotingTheSelection")}
              title={t("opencode.stopQuotingTheSelection")}
            >
              <XIcon className="size-3" />
            </button>
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-muted">
              {t("opencode.showTheQuotedTextCountCountCharacterChar", {
                count: editorSelection.ranges.reduce(
                  (count, range) => count + Array.from(range.text).length,
                  0,
                ),
              })}
            </summary>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">
              {editorSelection.ranges.map((range) => range.text).join("\n\n")}
            </pre>
          </details>
        </section>
      )}
      <AttachmentStrip
        files={attachedFiles}
        disabled={isSending}
        onRemove={(index) => setAttachedFiles((current) => current.filter((_, i) => i !== index))}
      />
      {attachments.error && (
        <p role="alert" className="px-3 py-2 text-xs text-red-600">
          {attachments.error}
        </p>
      )}
      {attachments.loading && (
        <p role="status" className="px-3 text-xs text-muted">
          {t("opencode.addingAttachments")}
        </p>
      )}

      <GrowingTextarea
        aria-label={t("opencode.messageToOpencode")}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onPaste={attachments.onPaste}
        placeholder={
          editorSelection
            ? t("opencode.describeHowToChangeTheSelection")
            : t("opencode.askOpencodeToFindReferencesOrEditTheSele")
        }
        className="writer-composer-input"
        rows={3}
      />
      <div className="writer-composer-toolbar">
        <CustomSelect
          value={selectedAgent || ""}
          options={agents.filter((a) => a?.id).map((a) => ({ value: a.id, label: a.name }))}
          onChange={(v) => onSelectAgent(v || null)}
        />

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <GroupedSelect
            value={selectedModel ? `${selectedModel.providerId}:${selectedModel.modelId}` : ""}
            displayLabel={
              selectedModelInfo.name !== "Model"
                ? `${selectedModelInfo.name} (${selectedModelInfo.provider})`
                : undefined
            }
            groups={providers
              .filter((p) => p?.id && (p.models || []).length > 0)
              .map((provider) => ({
                label: provider.name,
                options: (provider.models || [])
                  .filter((m) => m?.id)
                  .map((model) => ({
                    value: `${provider.id}:${model.id}`,
                    label: model.name,
                  })),
              }))}
            onChange={(v) => {
              const [providerId, modelId] = v.split(":");
              if (providerId && modelId) {
                const provider = providers.find((p) => p.id === providerId);
                const model = provider?.models.find((m) => m.id === modelId);
                const variant = isVariantEnabled(model?.variants, selectedModel?.variant)
                  ? selectedModel?.variant
                  : preferredVariant(model);
                onSelectModel({ providerId, modelId, variant });
              } else {
                onSelectModel(null);
              }
            }}
            className="min-w-0 max-w-[200px]"
          />
          {selectedModelInfo.isMax && (
            <span className="text-xs text-muted font-medium flex-shrink-0">Max</span>
          )}
          {selectedModel && variantOptions.length > 0 && (
            <CustomSelect
              value={selectedModel.variant ?? ""}
              options={variantOptions}
              onChange={(variant) =>
                onSelectModel({
                  ...selectedModel,
                  variant: variant || undefined,
                })
              }
              className="max-w-[110px]"
            />
          )}
        </div>

        <input
          ref={attachments.pickerRef}
          type="file"
          accept={undefined}
          multiple
          onChange={(event) => {
            void attachments.addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => void attachments.choose()}
          disabled={isSending}
          className={`flex size-8 items-center justify-center border border-border transition-colors flex-shrink-0 ${
            attachedFiles.length > 0 ? "text-accent" : "text-muted-foreground hover:text-muted"
          } ${isSending ? "opacity-50 cursor-not-allowed" : ""}`}
          title={t("opencode.addFilesOrImagesYouCanAlsoPasteOrDropThe")}
          aria-label={t("opencode.addAttachment")}
        >
          <PaperclipIcon className="size-4" />
          {attachedFiles.length > 0 && (
            <span className="sr-only">{attachedFiles.length} attached</span>
          )}
        </button>

        {isWorking && (
          <button
            type="button"
            onClick={onAbort}
            className="flex size-8 shrink-0 items-center justify-center border border-border text-muted hover:text-foreground transition-colors"
            title={t("opencode.stop")}
          >
            <StopIcon className="size-5" />
          </button>
        )}
        <button
          type="button"
          onClick={onSend}
          disabled={
            isSending || attachments.loading || (!input.trim() && attachedFiles.length === 0)
          }
          className="flex size-8 shrink-0 items-center justify-center bg-foreground text-background disabled:opacity-40"
          title={
            isWorking
              ? deliveryMode === "queue"
                ? t("opencode.queue")
                : t("opencode.steerNow")
              : t("opencode.send")
          }
          aria-label={
            isWorking
              ? deliveryMode === "queue"
                ? t("opencode.addToTheOpencodeQueue")
                : t("opencode.steerOpencodeNow")
              : t("opencode.sendToOpencode")
          }
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </div>
    </fieldset>
  );
}
