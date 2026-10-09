"use client";
import type { AnnotationRange, SourceMark } from "@lmms-lab/workbench";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useAnnotations } from "@/lib/pdf/annotation-context";

export type { AnnotationRange, SourceMark };
export function useSourceAnnotations(project?: string, path?: string, content = "") {
  const notes = useAnnotations();
  const [marked, setMarked] = useState<{ marks: SourceMark[]; content: string; key: string }>({
    marks: [],
    content,
    key: `${project}:${path}`,
  });

  const latest = useRef(content);
  latest.current = content;
  const documentKey = `${project}:${path}`;
  const items = notes?.items;
  useEffect(() => {
    if (!project || !path || !items?.some((n) => n.kind === "text" && n.anchor?.file === path)) {
      setMarked({ marks: [], content, key: documentKey });
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      void invoke<SourceMark[]>("annotation_marks_for_document", { project, path, content })
        .then((result) => {
          if (!disposed && latest.current === content)
            setMarked({ marks: result, content, key: documentKey });
        })
        .catch(() => {
          if (!disposed) setMarked({ marks: [], content, key: documentKey });
        });
    }, 120);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project, path, content, items, documentKey]);
  return {
    marks: marked.key === documentKey ? marked.marks : [],
    annotationContent: marked.content,
    notes,
  };
}
