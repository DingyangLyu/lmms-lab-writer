"use client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
import {
  type EditorSelectionContext,
  selectionMatchesDocument,
} from "@/lib/editor/selection-context";
import type { ConversationTab, ConversationTarget } from "@/lib/harness/types";
import { i18n } from "@/lib/i18n";
import { sameProject } from "@/lib/project-root";
import type { PdfAnnotation, PdfMark } from "./annotations";
export type AnnotationDraft = {
  kind?: "pdf" | "text";
  file?: string;
  base?: string;
  ranges?: Array<{ start: number; end: number; text: string }>;
  pdf: string;
  quote: string;
  marks: PdfMark[];
  fingerprint: string;
  style: "highlight" | "underline";
  comment: string;
};
type Context = {
  project?: string;
  items: PdfAnnotation[];
  open: boolean;
  setOpen: (v: boolean) => void;
  error: string | null;
  busy: boolean;
  draft: AnnotationDraft | null;
  setDraft: (draft: AnnotationDraft | null) => void;
  beginDraft: (draft: AnnotationDraft) => void;
  beginTextDraft: (
    selection: EditorSelectionContext,
    base: string,
    style?: "highlight" | "underline",
  ) => void;
  focusAnnotation: (id: string) => void;
  saveDraft: () => Promise<void>;
  update: (id: string, change: { comment?: string; resolved?: boolean }) => Promise<boolean>;
  conversations: ConversationTab[];
  submit: (ids: string[], target: ConversationTarget) => Promise<void>;
  selectedId: string | null;
  navigation: number;
  expanded: Set<string>;
  setExpanded: (ids: Set<string>) => void;
  showPdf: (note: PdfAnnotation) => void;
  showSource: (note: PdfAnnotation) => void;
  reload: () => Promise<void>;
};
const AnnotationContext = createContext<Context | null>(null);
export function useAnnotations() {
  return useContext(AnnotationContext);
}
export function AnnotationProvider({
  project,
  manager,
  onTask,
  conversations = [],
  onSource,
  onPdf,
  children,
}: {
  project?: string;
  manager: SaveManager;
  conversations?: ConversationTab[];
  onTask: (ids: string[], target: ConversationTarget) => void;
  onSource: (file: string, line: number) => void;
  onPdf: (file: string) => Promise<void>;
  children: ReactNode;
}) {
  const [items, setItems] = useState<PdfAnnotation[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [navigation, setNavigation] = useState(0);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [draftProject, setDraftProject] = useState<string | undefined>(undefined);
  const request = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const reload = useCallback(async () => {
    if (!project) return;
    const revision = ++request.current;
    const next = await invoke<PdfAnnotation[]>("pdf_list_annotations", { project, pdf: null });
    if (revision !== request.current || projectRef.current !== project) return;
    setItems(next);
  }, [project]);
  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    setItems([]);
    setExpanded(new Set());
    setSelectedId(null);
    setDraft(null);
    setOpen(false);
    setError(null);
    setDraftProject(undefined);
    if (!project) return;
    try {
      const saved = JSON.parse(
        localStorage.getItem(`writer-annotation-draft:${project}`) || "null",
      );
      if (
        saved &&
        typeof saved.pdf === "string" &&
        typeof saved.comment === "string" &&
        typeof saved.quote === "string" &&
        Array.isArray(saved.marks)
      ) {
        setDraft(saved);
      }
    } catch {
      /* A broken draft must not block saved annotations. */
    }
    setDraftProject(project);
    const refresh = () =>
      void reload().catch((cause) => {
        if (!disposed) setError(String(cause));
      });
    for (const event of ["writer://annotations-changed", "writer://bridge-changed"]) {
      void listen<{ project?: string }>(event, ({ payload }) => {
        if (!payload?.project || sameProject(payload.project, project)) refresh();
      })
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch((cause) => {
          if (!disposed) setError(String(cause));
        });
    }
    void manager
      .flushAll()
      .then(() => invoke("pdf_ensure_annotation_versions", { project }))
      .then(() => invoke("pdf_repair_annotation_quotes", { project }))
      .catch((cause) => {
        if (!disposed) setError(String(cause));
      })
      .finally(refresh);
    return () => {
      disposed = true;
      request.current++;
      stops.forEach((stop) => {
        stop();
      });
    };
  }, [project, manager, reload]);
  useEffect(() => {
    if (!project || draftProject !== project) return;
    try {
      const key = `writer-annotation-draft:${project}`;
      if (draft) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch {
      setError(i18n.t("msg.couldNotStashTheAnnotationDraftSaveBefor"));
    }
  }, [draft, project, draftProject]);
  const perform = async (action: () => Promise<void>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await manager.flushAll();
      await action();
      await reload();
      return true;
    } catch (cause) {
      setError(String(cause));
      setOpen(true);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const saveDraft = async () => {
    if (!project || !draft?.comment.trim()) return;
    const savedDraft = draft;
    await perform(async () => {
      const item =
        savedDraft.kind === "text"
          ? await invoke<PdfAnnotation>("add_text_annotation", {
              project,
              draft: {
                file: savedDraft.file,
                base: savedDraft.base,
                ranges: savedDraft.ranges,
                style: savedDraft.style,
                comment: savedDraft.comment,
              },
            })
          : await invoke<PdfAnnotation>("pdf_add_annotation", {
              project,
              annotation: {
                ...savedDraft,
                id: "",
                createdAt: 0,
                resolved: false,
                source: null,
                mappingNote: "",
                resolution: "",
              },
            });
      setSelectedId(item.id);
      setExpanded(new Set([item.id]));
      setDraft((current) => (current === savedDraft ? null : current));
    });
  };
  const update = (id: string, change: { comment?: string; resolved?: boolean }) =>
    perform(async () => {
      if (!project) return;
      await invoke("pdf_update_annotation", { project, id, ...change });
      if (change.resolved)
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
    });
  const submit = async (ids: string[], target: ConversationTarget) => {
    if (!project) return;
    const success = await perform(async () => {
      await invoke("pdf_prepare_annotations", { project, ids, backend: target.backend });
      if (projectRef.current !== project)
        throw new Error(i18n.t("msg.theProjectChangedSoTheAnnotationTaskWasN"));
      onTask(ids, target);
    });
    if (success) {
      setOpen(false);
    }
  };
  const beginDraft = (value: AnnotationDraft) => {
    // Selecting again re-targets a comment still being written instead of discarding it.
    setDraft((current) =>
      current?.comment.trim() && !value.comment.trim()
        ? { ...value, comment: current.comment }
        : value,
    );
    setOpen(true);
    setSelectedId(null);
  };
  const showPdf = (note: PdfAnnotation) => {
    setSelectedId(note.id);
    setNavigation((value) => value + 1);
    setOpen(false);
    if (note.kind !== "text") void onPdf(note.pdf).catch((cause) => setError(String(cause)));
  };
  return (
    <AnnotationContext.Provider
      value={{
        project,
        items,
        open,
        setOpen,
        error,
        busy,
        draft,
        setDraft,
        beginDraft,
        beginTextDraft: (selection, base, style = "highlight") => {
          if (selection.project !== project || !selectionMatchesDocument(selection, base)) {
            setError(i18n.t("msg.theSelectionDoesNotMatchTheCurrentManusc"));
            setOpen(true);
            return;
          }
          beginDraft({
            kind: "text",
            file: selection.path,
            base,
            ranges: selection.ranges.map((r) => ({
              start: r.startOffset,
              end: r.endOffset,
              text: r.text,
            })),
            pdf: "",
            marks: [],
            fingerprint: "",
            quote: selection.ranges.map((r) => r.text).join("\n…\n"),
            style,
            comment: "",
          });
        },
        focusAnnotation: (id) => {
          setSelectedId(id);
          setExpanded(new Set([id]));
          setOpen(true);
        },
        saveDraft,
        update,
        submit,
        conversations,
        selectedId,
        navigation,
        expanded,
        setExpanded,
        showPdf,
        showSource: (note) => {
          if (!note.source || !project) return;
          void manager
            .synchronize(project, [note.source.file])
            .then(() =>
              invoke<{
                annotations: Array<{
                  source?: { file: string; line: number };
                  currentRanges?: Array<{ line: number }>;
                }>;
              }>("writer_annotation_locations", { project, ids: [note.id] }),
            )
            .then((result) => {
              const current = result.annotations[0];
              const line = current?.currentRanges?.[0]?.line || note.source?.line;
              if (note.source && line) {
                setOpen(false);
                onSource(note.source.file, line);
              }
            })
            .catch((cause) => setError(String(cause)));
        },
        reload,
      }}
    >
      {children}
    </AnnotationContext.Provider>
  );
}
