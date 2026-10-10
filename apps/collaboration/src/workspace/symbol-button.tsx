/** The toolbar's symbol palette: a pop-over of math symbols written at the cursor. */
import { SymbolPalette } from "@lmms-lab/workbench";
import { useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Popover } from "./ui";

export function SymbolButton({ ws }: { ws: WorkspaceContext }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={!ws.canEdit}
        aria-expanded={open}
        title={t("workspace.symbolsTitle")}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
      >
        <span className="font-serif text-sm leading-none">Ω</span>
        <span className="hidden sm:inline">{t("workspace.symbols")}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t("workspace.symbolsTitle")}
        width={360}
      >
        <div className="flex max-h-[min(60vh,440px)] min-h-0 flex-col">
          <SymbolPalette onInsert={(command) => ws.editor.current?.insertSymbol(command)} />
        </div>
      </Popover>
    </>
  );
}
