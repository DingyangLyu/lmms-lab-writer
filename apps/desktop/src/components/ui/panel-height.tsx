"use client";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
export function clampPanelHeight(height: number, parentHeight: number, minimum: number) {
  const max = Math.max(0, parentHeight / 2);
  return Math.min(max, Math.max(Math.min(minimum, max), height));
}
export function usePanelHeight(key: string, defaultRatio: number | null = null, minimum = 200) {
  const ref = useRef<HTMLElement>(null);
  const [ratio, setRatio] = useState<number | null>(defaultRatio);
  const drag = useRef<{ y: number; height: number; parent: number } | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const value = Number(raw);
        if (Number.isFinite(value)) setRatio(Math.max(0, Math.min(0.5, value)));
      }
    } catch {
      /* Keep the usable default when preferences cannot be read. */
    }
  }, [key]);
  const setHeight = (height: number, parent: number) => {
    if (!parent) return;
    const next = clampPanelHeight(height, parent, minimum) / parent;
    setRatio(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* Resizing remains available. */
    }
  };
  const reset = () => {
    setRatio(defaultRatio);
    try {
      localStorage.removeItem(key);
    } catch {
      /* Preference is optional. */
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ref.current?.parentElement) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      y: event.clientY,
      height: ref.current.getBoundingClientRect().height,
      parent: ref.current.parentElement.clientHeight,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start) setHeight(start.height + start.y - event.clientY, start.parent);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === "Home") {
      event.preventDefault();
      reset();
      return;
    }
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || !ref.current?.parentElement) return;
    event.preventDefault();
    setHeight(
      ref.current.getBoundingClientRect().height + (event.key === "ArrowUp" ? 20 : -20),
      ref.current.parentElement.clientHeight,
    );
  };
  const style: CSSProperties =
    ratio === null
      ? { maxHeight: "50%" }
      : {
          height: `${ratio * 100}%`,
          maxHeight: "50%",
          minHeight: `min(${minimum}px, 50%)`,
          flex: "0 0 auto",
        };
  return {
    ref,
    style,
    manual: ratio !== null,
    ratio,
    reset,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
  };
}
export function PanelHeightHandle({
  control,
  label,
}: {
  control: ReturnType<typeof usePanelHeight>;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: A focusable drag handle needs pointer capture and a visible child grip.
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={50}
      aria-valuenow={Math.round((control.ratio ?? 0.2) * 100)}
      title={`${label} · 最多半屏 · 双击恢复默认高度`}
      onPointerDown={control.onPointerDown}
      onPointerMove={control.onPointerMove}
      onPointerUp={control.onPointerUp}
      onPointerCancel={control.onPointerUp}
      onLostPointerCapture={control.onPointerUp}
      onKeyDown={control.onKeyDown}
      onDoubleClick={control.reset}
      className="writer-height-handle"
    >
      <span />
    </div>
  );
}
export function ResizableComposer({
  children,
  backend,
}: {
  children: React.ReactNode;
  backend: string;
}) {
  const height = usePanelHeight(`writer-composer-height:${backend}`);
  return (
    <div
      ref={height.ref as React.RefObject<HTMLDivElement>}
      style={height.style}
      data-manual-size={height.manual || undefined}
      data-chat-composer={backend}
      className="writer-composer"
    >
      <PanelHeightHandle control={height} label="拖动调整输入区高度" />
      {children}
    </div>
  );
}
