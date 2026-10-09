"use client";
import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";
import { attachTextareaSizing } from "./textarea-sizing";
/** The composer remains in flex flow, reserving history space and capping input at half the panel. */
export function GrowingTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const sizing = useRef<ReturnType<typeof attachTextareaSizing> | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const current = attachTextareaSizing(ref.current);
    sizing.current = current;
    return () => {
      current.dispose();
      sizing.current = null;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Programmatic drafts/clearing must schedule measurement after React commits the value.
  useLayoutEffect(() => sizing.current?.schedule(), [props.value, props.placeholder, props.rows]);
  return <textarea {...props} ref={ref} />;
}
