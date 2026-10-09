/** Measure in an isolated mirror; never collapse the live input or reflow its chat history. */
export function attachTextareaSizing(textarea: HTMLTextAreaElement) {
  const doc = textarea.ownerDocument;
  const win = doc.defaultView;
  if (!win) return { schedule: () => {}, dispose: () => {} };
  const mirror = doc.createElement("textarea");
  mirror.tabIndex = -1;
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText =
    "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;overflow:hidden;resize:none;contain:strict;box-sizing:border-box;";
  doc.body.appendChild(mirror);
  let frame: number | null = null;
  let disposed = false,
    invalid = true,
    width = -1,
    borders = 0;
  const composer = textarea.closest("[data-chat-composer]");
  const measure = () => {
    frame = null;
    if (disposed || !textarea.clientWidth || composer?.hasAttribute("data-manual-size")) return;
    if (invalid || width !== textarea.clientWidth) {
      width = textarea.clientWidth;
      const style = win.getComputedStyle(textarea);
      for (const name of [
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "font-stretch",
        "line-height",
        "letter-spacing",
        "word-spacing",
        "text-indent",
        "text-transform",
        "tab-size",
        "padding-top",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "border-top-width",
        "border-bottom-width",
        "border-left-width",
        "border-right-width",
        "border-style",
        "white-space",
        "word-break",
        "overflow-wrap",
      ]) {
        mirror.style.setProperty(name, style.getPropertyValue(name));
      }
      borders =
        Number.parseFloat(style.borderTopWidth || "0") +
        Number.parseFloat(style.borderBottomWidth || "0");
      mirror.style.width = `${width + Number.parseFloat(style.borderLeftWidth || "0") + Number.parseFloat(style.borderRightWidth || "0")}px`;
      mirror.wrap = textarea.wrap;
      invalid = false;
    }
    mirror.value = textarea.value || textarea.placeholder || " ";
    const height = `${mirror.scrollHeight + borders}px`;
    if (textarea.style.height === height) return;
    const scroll = textarea.scrollTop;
    const atEnd =
      doc.activeElement === textarea &&
      textarea.selectionStart === textarea.value.length &&
      textarea.selectionEnd === textarea.value.length;
    textarea.style.height = height;
    textarea.scrollTop = atEnd ? textarea.scrollHeight : scroll;
  };
  const schedule = () => {
    if (!disposed && frame === null) frame = win.requestAnimationFrame(measure);
  };
  const resize = new ResizeObserver(() => {
    if (textarea.clientWidth !== width) {
      invalid = true;
      schedule();
    }
  });
  resize.observe(textarea);
  const mode = new MutationObserver(() => {
    invalid = true;
    schedule();
  });
  if (composer) mode.observe(composer, { attributes: true, attributeFilter: ["data-manual-size"] });
  mode.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  const fontsChanged = () => {
    invalid = true;
    schedule();
  };
  void doc.fonts?.ready.then(fontsChanged);
  doc.fonts?.addEventListener("loadingdone", fontsChanged);
  schedule();
  return {
    schedule,
    dispose: () => {
      disposed = true;
      if (frame !== null) win.cancelAnimationFrame(frame);
      resize.disconnect();
      mode.disconnect();
      doc.fonts?.removeEventListener("loadingdone", fontsChanged);
      mirror.remove();
    },
  };
}
