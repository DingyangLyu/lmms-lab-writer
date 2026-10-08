"use client";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
export function TemplateImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (path: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("paper-template");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (directory: boolean) => {
    try {
      const path = await open({
        directory,
        multiple: false,
        title: directory
          ? t("latex.chooseTheCompleteTemplateFolder")
          : t("latex.chooseALatexTemplateZip"),
        ...(!directory ? { filters: [{ name: t("latex.zipTemplate"), extensions: ["zip"] }] } : {}),
      });
      if (typeof path === "string") {
        setSource(path);
        setName(
          path
            .replace(/\\/g, "/")
            .split("/")
            .pop()
            ?.replace(/\.zip$/i, "") || "paper-template",
        );
      }
    } catch (cause) {
      setError(String(cause));
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("latex.importALatexTemplate")}
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/40 p-6"
    >
      <div className="w-full max-w-xl space-y-4 border border-border bg-background p-5 text-sm">
        <div className="flex justify-between">
          <strong>{t("latex.importALatexTemplate")}</strong>
          <button type="button" disabled={busy} onClick={onClose}>
            {t("latex.close")}
          </button>
        </div>
        <p className="text-xs text-muted">{t("latex.chooseACompleteDownloadedTemplateForExam")}</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(false)}
            className="border border-border px-3 py-2"
          >
            {t("latex.chooseZip")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(true)}
            className="border border-border px-3 py-2"
          >
            {t("latex.chooseFolder")}
          </button>
        </div>
        <p className="break-all text-xs">{source || t("latex.noTemplateChosen")}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void open({
              directory: true,
              multiple: false,
              title: t("latex.chooseWhereToPutTheNewProject"),
            })
              .then((value) => {
                if (typeof value === "string") setParent(value);
              })
              .catch((cause) => setError(String(cause)))
          }
          className="border border-border px-3 py-2"
        >
          {t("latex.chooseLocation")}
        </button>
        <p className="break-all text-xs">{parent || t("latex.noLocationChosen")}</p>
        <label className="block">
          {t("latex.newProjectFolderName")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="mt-1 w-full border border-border bg-background p-2"
          />
        </label>
        {error && (
          <p role="alert" className="whitespace-pre-wrap text-xs text-red-600">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={busy || !source || !parent || !name.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            void invoke<string>("latex_import_template", { source, parent, name: name.trim() })
              .then(onImported)
              .then(onClose)
              .catch((cause) => setError(String(cause)))
              .finally(() => setBusy(false));
          }}
          className="border border-foreground bg-foreground px-4 py-2 text-background disabled:opacity-40"
        >
          {busy ? t("latex.importing") : t("latex.importAndOpenTheNewProject")}
        </button>
      </div>
    </div>
  );
}
