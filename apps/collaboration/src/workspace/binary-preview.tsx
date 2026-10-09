/** Images and PDFs of the project shown in the editor area; other files can be downloaded. */
import { PdfViewer } from "@lmms-lab/workbench/pdf-viewer";
import { useEffect, useState } from "react";
import type { FileContent, FileInfo } from "../../shared/api";
import { api, errorText, unbase64 } from "../api";
import { useI18n } from "../i18n";
import "../pdf-setup";

const IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

export function BinaryPreview({ prefix, file }: { prefix: string; file: FileInfo }) {
  const { t } = useI18n();
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
  const image = IMAGES.includes(ext);
  useEffect(() => {
    let current = "",
      disposed = false;
    void api<FileContent>(`${prefix}/files/${file.id}`)
      .then((data) => {
        if (disposed || !("base64" in data)) return;
        const type =
          ext === "pdf"
            ? "application/pdf"
            : ext === "svg"
              ? "image/svg+xml"
              : image
                ? `image/${ext === "jpg" ? "jpeg" : ext}`
                : "application/octet-stream";
        current = URL.createObjectURL(new Blob([unbase64(data.base64)], { type }));
        setUrl(current);
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      disposed = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [prefix, file.id, ext, image]);
  if (error)
    return (
      <p role="alert" className="p-4 text-xs text-red-600">
        {error}
      </p>
    );
  if (!url) return <div className="flex-1 bg-accent-hover" />;
  if (ext === "pdf") return <PdfViewer src={url} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-accent-hover">
      <div className="flex shrink-0 items-center justify-end border-b border-border px-3 py-1 text-xs">
        <a href={url} download={file.path.split("/").pop()} className="hover:text-accent">
          {t("preview.download", { path: file.path })}
        </a>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {image ? (
          <img alt={file.path} src={url} className="max-h-full max-w-full object-contain" />
        ) : (
          <p className="text-xs text-muted">{t("preview.external")}</p>
        )}
      </div>
    </div>
  );
}
