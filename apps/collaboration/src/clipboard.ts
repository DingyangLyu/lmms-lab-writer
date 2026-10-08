/**
 * Copies text. Browsers only offer navigator.clipboard on HTTPS or localhost, so a lab server
 * opened by its plain-HTTP address falls back to copying a hidden selection.
 */
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}
