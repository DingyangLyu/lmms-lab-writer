/** Track a real primary-button gesture when WebKit omits MouseEvent.buttons. */
export class DragSelectionState {
  active = false;
  private legacyButtons = false;

  begin(button: number, buttons: number, webkit: boolean): boolean {
    this.active = button === 0;
    this.legacyButtons = this.active && webkit && buttons === 0;
    return this.active;
  }

  normalizeButtons(buttons: number): number {
    return this.active && this.legacyButtons && buttons === 0 ? 1 : buttons;
  }

  finish(): boolean {
    const wasActive = this.active;
    this.active = false;
    this.legacyButtons = false;
    return wasActive;
  }
}

/**
 * Keep CodeMirror's normal selection, modifier-key and auto-scroll handlers.
 * Only normalize a known broken WebKit gesture, observed as buttons=0 already
 * on primary mousedown. Never synthesize clicks or modify document content.
 */
export function trackEditorDrag(
  content: HTMLElement,
  onFinish: () => void,
): { state: DragSelectionState; dispose: () => void } {
  const doc = content.ownerDocument;
  const win = doc.defaultView;
  const ua = win?.navigator.userAgent ?? "";
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  const state = new DragSelectionState();
  let disposed = false;
  const normalize = (event: MouseEvent) => {
    const buttons = state.normalizeButtons(event.buttons);
    if (buttons !== event.buttons) {
      Object.defineProperty(event, "buttons", { configurable: true, value: buttons });
    }
  };
  const down = (event: MouseEvent) => {
    if (!content.contains(event.target as Node)) return;
    if (state.begin(event.button, event.buttons, webkit)) normalize(event);
  };
  const move = (event: MouseEvent) => normalize(event);
  const finish = () => {
    if (state.finish()) {
      // Read the final range after CodeMirror's mouseup handler has completed.
      queueMicrotask(() => {
        if (!disposed) onFinish();
      });
    }
  };
  const up = (event: MouseEvent) => {
    if (event.button === 0) finish();
  };
  const leave = (event: MouseEvent) => {
    if (!event.relatedTarget) finish();
  };
  doc.addEventListener("mousedown", down, true);
  doc.addEventListener("mousemove", move, true);
  doc.addEventListener("mouseup", up, true);
  doc.addEventListener("pointercancel", finish, true);
  doc.addEventListener("mouseout", leave, true);
  win?.addEventListener("blur", finish);
  return {
    state,
    dispose() {
      disposed = true;
      state.finish();
      doc.removeEventListener("mousedown", down, true);
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mouseup", up, true);
      doc.removeEventListener("pointercancel", finish, true);
      doc.removeEventListener("mouseout", leave, true);
      win?.removeEventListener("blur", finish);
    },
  };
}
