import { createContext, useContext } from "react";
import type { PdfAnnotation, PdfMark } from "./annotations";

/** A comment being written about a PDF selection. */
export type PdfDraft = {
  pdf: string;
  quote: string;
  marks: PdfMark[];
  fingerprint: string;
  style: "highlight" | "underline";
  comment: string;
};
/** What the PDF preview needs from the app's comment store. */
export type PdfAnnotationHost = {
  items: PdfAnnotation[];
  /** Any draft in progress; the preview only checks whether one exists. */
  draft: unknown;
  beginDraft: (draft: PdfDraft) => void;
  selectedId: string | null;
  /** Bumped to scroll to `selectedId` again. */
  navigation: number;
  setOpen: (open: boolean) => void;
  /** A click on the note beside comments on the page (several on one line open together). */
  openNotes?: (ids: string[]) => void;
};
export const PdfAnnotationContext = createContext<PdfAnnotationHost | null>(null);
/** The app's PDF comments, or null where the preview is read-only. */
export const useAnnotations = () => useContext(PdfAnnotationContext);
