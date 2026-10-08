import { useEffect, useState } from "react";
import type { FileContent, FileInfo } from "../../shared/api";
import { api, errorText, unbase64 } from "../api";
import { useI18n } from "../i18n";

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
  return (
    <div className="binary-preview">
      {error && <p className="error">{error}</p>}
      {url && (
        <>
          <a href={url} download={file.path.split("/").pop()}>
            {t("preview.download", { path: file.path })}
          </a>
          {ext === "pdf" ? (
            <iframe title={file.path} src={url} />
          ) : image ? (
            <img alt={file.path} src={url} />
          ) : (
            <p>{t("preview.external")}</p>
          )}
        </>
      )}
    </div>
  );
}
