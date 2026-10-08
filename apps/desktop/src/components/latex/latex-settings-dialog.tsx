"use client";

import { ArrowCounterClockwiseIcon, MinusIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useId, useState } from "react";
import { ServerAccounts } from "@/components/collab/server-accounts";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  type MinimapSettings,
} from "@/lib/editor/types";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_LATEX_SETTINGS, type LaTeXSettings } from "@/lib/latex/types";

interface LaTeXSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: LaTeXSettings;
  onUpdateSettings: (updates: Partial<LaTeXSettings>) => void;
  editorSettings: EditorSettings;
  onUpdateEditorSettings: (updates: Partial<EditorSettings>) => void;
  texFiles: string[];
  buildSettings?: React.ReactNode;
  /** The tab shown each time the dialog opens. */
  initialTab?: "build" | "editor" | "collab";
}

// Section header component for visual grouping - editorial style
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-6 pb-2 border-t border-border mt-4 first:mt-0 first:border-t-0 first:pt-2">
      <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
        {children}
      </h3>
    </div>
  );
}

function CheckboxItem({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
}) {
  const checkboxId = useId();

  return (
    <label htmlFor={checkboxId} className="flex items-start gap-3 cursor-pointer group py-2">
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <div className="flex-1">
        <span className="text-sm font-medium text-foreground-secondary group-hover:text-foreground transition-colors">
          {label}
        </span>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  description,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  options: { value: string | number; label: string }[];
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 gap-8">
      <div className="shrink-0">
        <span className="text-sm font-medium text-foreground-secondary block">{label}</span>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={String(opt.value)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AppearanceToggle() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div className="py-2">
      <span className="text-sm font-medium block mb-2 text-foreground-secondary">
        {t("settings.colorMode")}
      </span>
      <div className="flex">
        {(
          [
            { value: "light", label: t("settings.light") },
            { value: "dark", label: t("settings.dark") },
          ] as const
        ).map((mode, index) => (
          <button
            type="button"
            key={mode.value}
            onClick={() => setTheme(mode.value)}
            className={`flex-1 px-4 py-2.5 text-sm font-medium border transition-all ${
              theme === mode.value
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted border-border hover:border-border-dark"
            } ${index === 0 ? "" : "-ml-px"}`}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted mt-1.5">{t("settings.controlsTheAppAndEditorTheme")}</p>
    </div>
  );
}

export function LaTeXSettingsDialog({
  open,
  onClose,
  settings,
  onUpdateSettings,
  editorSettings,
  onUpdateEditorSettings,
  texFiles,
  buildSettings,
  initialTab = "build",
}: LaTeXSettingsDialogProps) {
  const { t, locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  useEffect(() => {
    if (open) setActiveTab(initialTab);
  }, [open, initialTab]);

  const handleResetLatexSettings = useCallback(() => {
    onUpdateSettings(DEFAULT_LATEX_SETTINGS);
  }, [onUpdateSettings]);

  const handleResetEditorSettings = useCallback(() => {
    onUpdateEditorSettings(DEFAULT_EDITOR_SETTINGS);
  }, [onUpdateEditorSettings]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-foreground/50 z-[9999]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] bg-background border-2 border-foreground shadow-[4px_4px_0_0_var(--foreground)] w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <Dialog.Title className="text-lg font-bold tracking-tight">
                {t("settings.settings")}
              </Dialog.Title>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {t("settings.autoSaved")}
              </span>
            </div>
            <Dialog.Close
              className="p-1.5 hover:bg-accent-hover transition-colors border border-transparent hover:border-border"
              aria-label={t("settings.close")}
            >
              <XIcon className="size-4" />
            </Dialog.Close>
          </div>

          <Tabs.Root
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex-1 flex flex-col overflow-hidden"
          >
            {/* Tabs */}
            <Tabs.List className="flex border-b border-border shrink-0">
              <Tabs.Trigger
                value="build"
                className="flex-1 px-4 py-3 text-sm font-medium transition-colors relative text-muted-foreground hover:text-foreground data-[state=active]:text-foreground"
              >
                {t("settings.build")}
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground transition-opacity opacity-0 data-[state=active]:opacity-100" />
              </Tabs.Trigger>
              <Tabs.Trigger
                value="editor"
                className="flex-1 px-4 py-3 text-sm font-medium transition-colors relative text-muted-foreground hover:text-foreground data-[state=active]:text-foreground"
              >
                {t("settings.editor")}
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground transition-opacity opacity-0 data-[state=active]:opacity-100" />
              </Tabs.Trigger>
              <Tabs.Trigger
                value="collab"
                className="flex-1 px-4 py-3 text-sm font-medium transition-colors relative text-muted-foreground hover:text-foreground data-[state=active]:text-foreground"
              >
                {t("collab.accounts.tab")}
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground transition-opacity opacity-0 data-[state=active]:opacity-100" />
              </Tabs.Trigger>
            </Tabs.List>

            {/* ===== EDITOR TAB ===== */}
            <Tabs.Content value="editor" className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
              <SectionHeader>{t("settings.language")}</SectionHeader>
              <div className="flex items-center justify-between gap-4 py-2">
                <p className="text-xs text-muted-foreground">{t("settings.language.hint")}</p>
                <select
                  aria-label={t("settings.language")}
                  value={locale}
                  onChange={(e) => setLocale(e.target.value === "en" ? "en" : "zh")}
                  className="border border-border bg-background px-2 py-1 text-sm"
                >
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select>
              </div>

              <SectionHeader>{t("settings.appearance")}</SectionHeader>

              {/* Light/Dark Mode Toggle */}
              <AppearanceToggle />

              <SectionHeader>{t("settings.keybindings")}</SectionHeader>

              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 border flex items-center justify-center font-mono text-xs font-bold tracking-tight transition-colors ${
                      editorSettings.vimMode
                        ? "bg-foreground border-foreground text-background"
                        : "bg-accent-hover border-border text-muted-foreground"
                    }`}
                  >
                    Vi
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground-secondary">
                        {t("settings.vimMode")}
                      </span>
                      {editorSettings.vimMode && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-foreground text-background font-mono font-bold tracking-wider">
                          NORMAL
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {t("settings.modalVimStyleKeybindingsInEditor")}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.vimMode}
                  onCheckedChange={(v) => onUpdateEditorSettings({ vimMode: v })}
                />
              </div>

              <SectionHeader>{t("settings.display")}</SectionHeader>

              <div className="flex items-center justify-between py-2 gap-4">
                <label
                  htmlFor="editor-font-family"
                  className="text-sm font-medium text-foreground-secondary shrink-0"
                >
                  {t("settings.fontFamily")}
                </label>
                <input
                  id="editor-font-family"
                  type="text"
                  value={editorSettings.fontFamily}
                  onChange={(e) =>
                    onUpdateEditorSettings({
                      fontFamily: e.target.value,
                    })
                  }
                  placeholder={t("settings.defaultMonospaceStack")}
                  className="w-full max-w-sm px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                />
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-font-size"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  {t("settings.fontSize")}
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        fontSize: Math.max(8, editorSettings.fontSize - 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label={t("settings.decreaseFontSize")}
                  >
                    <MinusIcon className="size-3" />
                  </button>
                  <input
                    id="editor-font-size"
                    type="number"
                    min="8"
                    max="32"
                    value={editorSettings.fontSize}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        fontSize: Math.min(32, Math.max(8, parseInt(e.target.value, 10) || 14)),
                      })
                    }
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        fontSize: Math.min(32, editorSettings.fontSize + 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label={t("settings.increaseFontSize")}
                  >
                    <PlusIcon className="size-3" />
                  </button>
                  <span className="text-xs text-muted-foreground px-2 border-l border-border">
                    px
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-line-height"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  {t("settings.lineHeight")}
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        lineHeight: Math.max(
                          1.0,
                          Math.round((editorSettings.lineHeight - 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label={t("settings.decreaseLineHeight")}
                  >
                    <MinusIcon className="size-3" />
                  </button>
                  <input
                    id="editor-line-height"
                    type="number"
                    min="1.0"
                    max="3.0"
                    step="0.1"
                    value={editorSettings.lineHeight.toFixed(1)}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        lineHeight: Math.min(3.0, Math.max(1.0, parseFloat(e.target.value) || 1.6)),
                      })
                    }
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        lineHeight: Math.min(
                          3.0,
                          Math.round((editorSettings.lineHeight + 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label={t("settings.increaseLineHeight")}
                  >
                    <PlusIcon className="size-3" />
                  </button>
                </div>
              </div>

              <SelectField
                label={t("settings.lineNumbers")}
                value={editorSettings.lineNumbers}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    lineNumbers: v as EditorSettings["lineNumbers"],
                  })
                }
                options={[
                  { value: "on", label: t("settings.on") },
                  { value: "off", label: t("settings.off") },
                  { value: "relative", label: t("settings.relative") },
                  { value: "interval", label: t("settings.intervalEvery10") },
                ]}
              />

              <SelectField
                label={t("settings.renderWhitespace")}
                value={editorSettings.renderWhitespace}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    renderWhitespace: v as EditorSettings["renderWhitespace"],
                  })
                }
                options={[
                  { value: "none", label: t("settings.none") },
                  { value: "boundary", label: t("settings.boundary") },
                  { value: "selection", label: t("settings.selection") },
                  { value: "trailing", label: t("settings.trailing") },
                  { value: "all", label: t("settings.all") },
                ]}
              />

              <CheckboxItem
                checked={editorSettings.highlightAmbiguousUnicode}
                onChange={(enabled) =>
                  onUpdateEditorSettings({ highlightAmbiguousUnicode: enabled })
                }
                label={t("settings.boxesAroundChinesePunctuation")}
                description={t("settings.marksFullWidthPunctuationThatIsEasilyCon")}
              />

              <div className="space-y-3 pt-1">
                <CheckboxItem
                  checked={editorSettings.smoothScrolling}
                  onChange={(v) => onUpdateEditorSettings({ smoothScrolling: v })}
                  label={t("settings.smoothScrolling")}
                  description={t("settings.enableSmoothScrollAnimation")}
                />
              </div>

              <SectionHeader>{t("settings.minimap")}</SectionHeader>

              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground-secondary">
                      {t("settings.enableMinimap")}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 border border-border text-muted font-medium uppercase tracking-wider">
                      {t("settings.preview")}
                    </span>
                  </div>
                  <p className="text-xs text-muted mt-0.5">{t("settings.codeOverviewPanel")}</p>
                </div>
                <Switch
                  checked={editorSettings.minimap.enabled}
                  onCheckedChange={(v) =>
                    onUpdateEditorSettings({
                      minimap: {
                        ...editorSettings.minimap,
                        enabled: v,
                      },
                    })
                  }
                />
              </div>

              {editorSettings.minimap.enabled && (
                <div className="space-y-1 pl-4 border-l-2 border-border ml-1">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-sm font-medium text-foreground-secondary">
                      {t("settings.position")}
                    </span>
                    <div className="flex">
                      {(["left", "right"] as const).map((side, index) => (
                        <button
                          type="button"
                          key={side}
                          onClick={() =>
                            onUpdateEditorSettings({
                              minimap: {
                                ...editorSettings.minimap,
                                side,
                              },
                            })
                          }
                          className={`px-4 py-1.5 text-sm border transition-all ${
                            editorSettings.minimap.side === side
                              ? "bg-foreground text-background border-foreground"
                              : "bg-background text-muted border-border hover:border-border-dark"
                          } ${index === 0 ? "" : "-ml-px"}`}
                        >
                          {side === "left" ? t("settings.left") : t("settings.right")}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Size Mode */}
                  <SelectField
                    label={t("settings.sizeMode")}
                    value={editorSettings.minimap.size}
                    onChange={(v) =>
                      onUpdateEditorSettings({
                        minimap: {
                          ...editorSettings.minimap,
                          size: v as MinimapSettings["size"],
                        },
                      })
                    }
                    options={[
                      { value: "proportional", label: t("settings.proportional") },
                      { value: "fill", label: t("settings.fill") },
                      { value: "fit", label: t("settings.fit") },
                    ]}
                    description={t("settings.howTheMinimapScalesRelativeToContent")}
                  />

                  {/* Show Slider */}
                  <SelectField
                    label={t("settings.showSlider")}
                    value={editorSettings.minimap.showSlider}
                    onChange={(v) =>
                      onUpdateEditorSettings({
                        minimap: {
                          ...editorSettings.minimap,
                          showSlider: v as MinimapSettings["showSlider"],
                        },
                      })
                    }
                    options={[
                      { value: "mouseover", label: t("settings.onHover") },
                      { value: "always", label: t("settings.always") },
                    ]}
                    description={t("settings.whenToShowTheViewportIndicator")}
                  />

                  {/* Render Characters */}
                  <div className="pt-2">
                    <CheckboxItem
                      checked={editorSettings.minimap.renderCharacters}
                      onChange={(v) =>
                        onUpdateEditorSettings({
                          minimap: {
                            ...editorSettings.minimap,
                            renderCharacters: v,
                          },
                        })
                      }
                      label={t("settings.renderCharacters")}
                      description={t("settings.showActualCharactersInsteadOfBlocks")}
                    />
                  </div>
                </div>
              )}

              <SectionHeader>{t("settings.cursor")}</SectionHeader>

              <SelectField
                label={t("settings.cursorStyle")}
                value={editorSettings.cursorStyle}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    cursorStyle: v as EditorSettings["cursorStyle"],
                  })
                }
                options={[
                  { value: "line", label: t("settings.line") },
                  { value: "line-thin", label: t("settings.lineThin") },
                  { value: "block", label: t("settings.block") },
                  { value: "block-outline", label: t("settings.blockOutline") },
                  { value: "underline", label: t("settings.underline") },
                  { value: "underline-thin", label: t("settings.underlineThin") },
                ]}
              />

              <SelectField
                label={t("settings.cursorBlinking")}
                value={editorSettings.cursorBlinking}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    cursorBlinking: v as EditorSettings["cursorBlinking"],
                  })
                }
                options={[
                  { value: "blink", label: t("settings.blink") },
                  { value: "smooth", label: t("settings.smooth") },
                  { value: "phase", label: t("settings.phase") },
                  { value: "expand", label: t("settings.expand") },
                  { value: "solid", label: t("settings.solid") },
                ]}
              />

              <SectionHeader>{t("settings.editing")}</SectionHeader>

              <SelectField
                label={t("settings.tabSize")}
                value={editorSettings.tabSize}
                onChange={(v) => onUpdateEditorSettings({ tabSize: parseInt(v, 10) })}
                options={[
                  { value: 2, label: t("settings.2Spaces") },
                  { value: 4, label: t("settings.4Spaces") },
                  { value: 8, label: t("settings.8Spaces") },
                ]}
              />

              <SelectField
                label={t("settings.wordWrap")}
                value={editorSettings.wordWrap}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    wordWrap: v as EditorSettings["wordWrap"],
                  })
                }
                options={[
                  { value: "off", label: t("settings.off") },
                  { value: "on", label: t("settings.on") },
                  { value: "wordWrapColumn", label: t("settings.wrapAtColumn") },
                  { value: "bounded", label: t("settings.bounded") },
                ]}
              />

              {editorSettings.wordWrap === "wordWrapColumn" && (
                <div className="pl-4 border-l-2 border-border ml-1 py-2">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="editor-word-wrap-column"
                      className="text-sm font-medium text-foreground-secondary"
                    >
                      {t("settings.wrapColumn")}
                    </label>
                    <input
                      id="editor-word-wrap-column"
                      type="number"
                      min="40"
                      max="200"
                      value={editorSettings.wordWrapColumn}
                      onChange={(e) =>
                        onUpdateEditorSettings({
                          wordWrapColumn: parseInt(e.target.value, 10) || 80,
                        })
                      }
                      className="w-20 px-3 py-2 text-sm text-center border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono"
                    />
                  </div>
                </div>
              )}

              <SelectField
                label={t("settings.autoCloseBrackets")}
                value={editorSettings.autoClosingBrackets}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    autoClosingBrackets: v as EditorSettings["autoClosingBrackets"],
                  })
                }
                options={[
                  { value: "always", label: t("settings.always") },
                  { value: "languageDefined", label: t("settings.languageDefined") },
                  {
                    value: "beforeWhitespace",
                    label: t("settings.beforeWhitespace"),
                  },
                  { value: "never", label: t("settings.never") },
                ]}
              />

              <SelectField
                label={t("settings.autoCloseQuotes")}
                value={editorSettings.autoClosingQuotes}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    autoClosingQuotes: v as EditorSettings["autoClosingQuotes"],
                  })
                }
                options={[
                  { value: "always", label: t("settings.always") },
                  { value: "languageDefined", label: t("settings.languageDefined") },
                  {
                    value: "beforeWhitespace",
                    label: t("settings.beforeWhitespace"),
                  },
                  { value: "never", label: t("settings.never") },
                ]}
              />

              <div className="space-y-3 pt-1">
                <CheckboxItem
                  checked={editorSettings.insertSpaces}
                  onChange={(v) => onUpdateEditorSettings({ insertSpaces: v })}
                  label={t("settings.insertSpaces")}
                  description={t("settings.useSpacesInsteadOfTabsForIndentation")}
                />
              </div>

              <SectionHeader>{t("settings.formatting")}</SectionHeader>

              <div className="space-y-3">
                <CheckboxItem
                  checked={editorSettings.formatOnSave}
                  onChange={(v) => onUpdateEditorSettings({ formatOnSave: v })}
                  label={t("settings.formatOnSave")}
                  description={t("settings.automaticallyFormatCodeWhenSaving")}
                />
                <CheckboxItem
                  checked={editorSettings.formatOnPaste}
                  onChange={(v) => onUpdateEditorSettings({ formatOnPaste: v })}
                  label={t("settings.formatOnPaste")}
                  description={t("settings.automaticallyFormatPastedCode")}
                />
              </div>

              <SectionHeader>{t("settings.terminal")}</SectionHeader>

              <div className="flex items-center justify-between py-2 gap-4">
                <label
                  htmlFor="editor-terminal-font-family"
                  className="text-sm font-medium text-foreground-secondary shrink-0"
                >
                  {t("settings.fontFamily")}
                </label>
                <input
                  id="editor-terminal-font-family"
                  type="text"
                  value={editorSettings.terminalFontFamily}
                  onChange={(e) =>
                    onUpdateEditorSettings({
                      terminalFontFamily: e.target.value,
                    })
                  }
                  placeholder={t("settings.defaultMonospaceStack")}
                  className="w-full max-w-sm px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                />
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-terminal-font-size"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  {t("settings.fontSize")}
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.max(8, editorSettings.terminalFontSize - 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label={t("settings.decreaseTerminalFontSize")}
                  >
                    <MinusIcon className="size-3" />
                  </button>
                  <input
                    id="editor-terminal-font-size"
                    type="number"
                    min="8"
                    max="32"
                    value={editorSettings.terminalFontSize}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.min(
                          32,
                          Math.max(8, parseInt(e.target.value, 10) || 13),
                        ),
                      })
                    }
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalFontSize: Math.min(32, editorSettings.terminalFontSize + 1),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label={t("settings.increaseTerminalFontSize")}
                  >
                    <PlusIcon className="size-3" />
                  </button>
                  <span className="text-xs text-muted-foreground px-2 border-l border-border">
                    px
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <label
                  htmlFor="editor-terminal-line-height"
                  className="text-sm font-medium text-foreground-secondary"
                >
                  {t("settings.lineHeight")}
                </label>
                <div className="flex items-center border border-border hover:border-border-dark transition-colors">
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalLineHeight: Math.max(
                          1.0,
                          Math.round((editorSettings.terminalLineHeight - 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-r border-border"
                    aria-label={t("settings.decreaseTerminalLineHeight")}
                  >
                    <MinusIcon className="size-3" />
                  </button>
                  <input
                    id="editor-terminal-line-height"
                    type="number"
                    min="1.0"
                    max="3.0"
                    step="0.1"
                    value={editorSettings.terminalLineHeight.toFixed(1)}
                    onChange={(e) =>
                      onUpdateEditorSettings({
                        terminalLineHeight: Math.min(
                          3.0,
                          Math.max(1.0, parseFloat(e.target.value) || 1.4),
                        ),
                      })
                    }
                    className="w-12 h-8 text-sm text-center border-0 focus:outline-none focus:ring-0 font-mono bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateEditorSettings({
                        terminalLineHeight: Math.min(
                          3.0,
                          Math.round((editorSettings.terminalLineHeight + 0.1) * 10) / 10,
                        ),
                      })
                    }
                    className="w-8 h-8 flex items-center justify-center text-muted hover:text-foreground hover:bg-accent-hover transition-colors border-l border-border"
                    aria-label={t("settings.increaseTerminalLineHeight")}
                  >
                    <PlusIcon className="size-3" />
                  </button>
                </div>
              </div>

              <SelectField
                label={t("settings.shellSelection")}
                value={editorSettings.terminalShellMode}
                onChange={(v) =>
                  onUpdateEditorSettings({
                    terminalShellMode: v as EditorSettings["terminalShellMode"],
                  })
                }
                options={[
                  { value: "auto", label: t("settings.autoDetect") },
                  { value: "custom", label: t("settings.custom") },
                ]}
                description={t("settings.autoModeChoosesShellPerOsFallbackRules")}
              />

              {editorSettings.terminalShellMode === "custom" && (
                <div className="pl-4 border-l-2 border-border ml-1 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <label
                      htmlFor="editor-terminal-shell-path"
                      className="text-sm font-medium text-foreground-secondary shrink-0"
                    >
                      {t("settings.shellCommand")}
                    </label>
                    <input
                      id="editor-terminal-shell-path"
                      type="text"
                      value={editorSettings.terminalShellPath}
                      onChange={(e) =>
                        onUpdateEditorSettings({
                          terminalShellPath: e.target.value,
                        })
                      }
                      placeholder="powershell.exe / pwsh / /bin/zsh"
                      className="w-full px-3 py-2 text-sm border border-border hover:border-border-dark focus:outline-none focus:border-foreground font-mono bg-background"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    {t("settings.leaveEmptyToFallBackToAutoDetection")}
                  </p>
                </div>
              )}
            </Tabs.Content>

            {/* ===== BUILD TAB ===== */}
            <Tabs.Content value="build" className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
              {buildSettings ?? (
                <>
                  <SectionHeader>{t("settings.mainFile")}</SectionHeader>

                  <div className="py-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground-secondary">
                        {t("settings.mainTexFile")}
                      </span>
                    </div>
                    {texFiles.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">
                        {t("settings.noTexFilesFoundInProject")}
                      </p>
                    ) : (
                      <Select
                        value={settings.mainFile || ""}
                        onValueChange={(v) => onUpdateSettings({ mainFile: v || null })}
                      >
                        <SelectTrigger className="w-full" aria-label={t("settings.mainTexFile")}>
                          <SelectValue placeholder={t("settings.selectMainTexFile")} />
                        </SelectTrigger>
                        <SelectContent>
                          {texFiles.map((file) => (
                            <SelectItem key={file} value={file}>
                              {file}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {t("settings.theEntryPointForLatexCompilation")}
                    </p>
                  </div>
                </>
              )}
              <SectionHeader>{t("settings.git")}</SectionHeader>

              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 border flex items-center justify-center transition-colors ${
                      editorSettings.gitAutoFetchEnabled
                        ? "bg-foreground border-foreground"
                        : "bg-accent-hover border-border"
                    }`}
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      className={
                        editorSettings.gitAutoFetchEnabled
                          ? "text-background"
                          : "text-muted-foreground"
                      }
                    >
                      <path
                        d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 2.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM4.5 8a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm7 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"
                        fill="currentColor"
                        fillRule="evenodd"
                      />
                      <path
                        d="M8 5.75v2.5M6 9l-1-.5M10 9l1-.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground-secondary">
                        {t("settings.autoFetch")}
                      </span>
                      {editorSettings.gitAutoFetchEnabled && (
                        <span className="text-[10px] px-1.5 py-0.5 border border-emerald-300 text-emerald-600 font-medium uppercase tracking-wider bg-emerald-50">
                          {t("settings.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {t("settings.periodicallySyncRemoteRefsInBackground")}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={editorSettings.gitAutoFetchEnabled}
                  onCheckedChange={(v) => onUpdateEditorSettings({ gitAutoFetchEnabled: v })}
                />
              </div>

              {editorSettings.gitAutoFetchEnabled && (
                <div className="pl-4 border-l-2 border-border ml-1">
                  <SelectField
                    label={t("settings.interval")}
                    value={editorSettings.gitAutoFetchIntervalSeconds}
                    onChange={(v) =>
                      onUpdateEditorSettings({
                        gitAutoFetchIntervalSeconds: Math.min(
                          3600,
                          Math.max(15, parseInt(v, 10) || 120),
                        ),
                      })
                    }
                    options={[
                      { value: 30, label: t("settings.30Seconds") },
                      { value: 60, label: t("settings.1Minute") },
                      { value: 120, label: t("settings.2Minutes") },
                      { value: 300, label: t("settings.5Minutes") },
                      { value: 600, label: t("settings.10Minutes") },
                    ]}
                  />
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content value="collab" className="flex-1 overflow-y-auto px-5 py-4">
              <ServerAccounts />
            </Tabs.Content>
          </Tabs.Root>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t border-border">
            {activeTab === "collab" ? (
              <span />
            ) : (
              <button
                type="button"
                onClick={
                  activeTab === "editor" ? handleResetEditorSettings : handleResetLatexSettings
                }
                className="text-xs text-muted hover:text-foreground transition-colors flex items-center gap-1.5 group"
              >
                <ArrowCounterClockwiseIcon className="size-3.5 group-hover:rotate-[-45deg] transition-transform" />
                {t("settings.resetToDefaults")}
              </button>
            )}
            <Dialog.Close className="px-6 py-2 text-sm font-medium bg-background text-foreground border-2 border-foreground shadow-[3px_3px_0_0_var(--foreground)] hover:shadow-[1px_1px_0_0_var(--foreground)] hover:translate-x-[2px] hover:translate-y-[2px] transition-all">
              {t("settings.done")}
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
