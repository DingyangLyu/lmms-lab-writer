"use client";
import { PdfViewer as SharedPdfViewer } from "@lmms-lab/workbench/pdf-viewer";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { type ComponentProps, useCallback } from "react";
import { pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** The shared PDF preview, reading a font-repaired copy prepared by the backend. */
export function PdfViewer(props: Omit<ComponentProps<typeof SharedPdfViewer>, "prepare">) {
  const { project } = props;
  const prepare = useCallback(
    async (pdf: string) => {
      const result = await invoke<{ path: string; repairedFonts: string[]; warnings: string[] }>(
        "pdf_prepare_preview",
        { project, pdf },
      );
      return { ...result, url: convertFileSrc(result.path) };
    },
    [project],
  );
  return <SharedPdfViewer {...props} prepare={prepare} />;
}
