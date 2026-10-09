/** The compiled PDF beside the editor, as the desktop's split preview, with the build status. */
import { PdfViewer } from "@lmms-lab/workbench/pdf-viewer";
import { CrosshairIcon, DownloadSimpleIcon, XIcon } from "@phosphor-icons/react";
import "../pdf-setup";
import { useI18n } from "../i18n";
import type { BuildState } from "./build";
import type { WorkspaceContext } from "./context";

export function BuildSummary({ b }: { b: BuildState }) {
  const { t, locale } = useI18n();
  const { build } = b;
  if (b.compiling) return <span className="animate-pulse">{t("build.running")}</span>;
  if (!build) return <span className="text-muted">{t("build.none")}</span>;
  return (
    <span className={build.status === "success" ? "" : "text-red-600"}>
      {build.status === "success" ? t("build.success") : t("build.failed")} · {build.main} ·{" "}
      {t("build.seconds", { seconds: (build.duration / 1000).toFixed(1) })} ·{" "}
      {new Date(build.created).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en")}
    </span>
  );
}

export function PdfPane({
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
  const icon =
    "flex h-6 w-6 shrink-0 items-center justify-center text-muted hover:bg-accent-hover hover:text-foreground disabled:opacity-40";
  return (
    <section aria-label={t("build.preview")} className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2 text-xs">
        <span className="min-w-0 flex-1 truncate">
          <BuildSummary b={b} />
        </span>
        {build?.pdf && ws.file && !ws.file.binary && (
          <button
            type="button"
            className={icon}
            title={t("build.forwardTitle")}
            aria-label={t("build.forward")}
            onClick={b.showCursorInPdf}
          >
            <CrosshairIcon className="size-4" />
          </button>
        )}
        {build?.pdf && (
          <a
            className={icon}
            href={`/api${ws.prefix}/builds/${build.id}/pdf`}
            download="output.pdf"
            title={t("build.download")}
            aria-label={t("build.download")}
          >
            <DownloadSimpleIcon className="size-4" />
          </a>
        )}
        <button
          type="button"
          className={icon}
          title={t("build.hidePdf")}
          aria-label={t("build.hidePdf")}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {build?.pdf ? (
          <PdfViewer
            src={`/api${ws.prefix}/builds/${build.id}/pdf`}
            highlight={b.highlight}
            onSynctexClick={b.showPdfInSource}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-accent-hover p-6 text-center text-xs text-muted">
            {build ? t("build.noPdf") : t("build.none")}
          </div>
        )}
      </div>
    </section>
  );
}
