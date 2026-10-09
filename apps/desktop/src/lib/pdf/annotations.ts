import { i18n } from "@/lib/i18n";

export {
  type AnnotationEvent,
  type AnnotationSource,
  collectSelection,
  joinLines,
  MAX_MARKS,
  mergeMarks,
  normalizeRect,
  type PdfAnnotation,
  type PdfMark,
  visibleTextMarks,
} from "@lmms-lab/workbench";

export function annotationPrompt(
  ids: string[],
  backend: import("@/lib/harness/types").HarnessId,
): string {
  return i18n.t("msg.annotationPrompt", { ids: JSON.stringify(ids), backend });
}
