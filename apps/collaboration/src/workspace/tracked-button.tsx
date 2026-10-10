/**
 * Track changes in the editor's toolbar, as Overleaf's review panel: turn it on for everyone or
 * for oneself, and the open file's changes to look at, accept or reject one by one or all.
 */
import { CheckIcon, PencilLineIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { Member } from "../../shared/api";
import { userHue } from "../../shared/tracked";
import { api } from "../api";
import { ago } from "../dashboard";
import { useI18n } from "../i18n";
import { deletedText, type ShownChange } from "../tracked-changes";
import type { WorkspaceContext } from "./context";
import { Btn, Popover } from "./ui";

export function TrackedButton({
  ws,
  changes,
  trackAll,
  members,
}: {
  ws: WorkspaceContext;
  /** The open file's changes, as the editor reports them. */
  changes: ShownChange[];
  trackAll: boolean;
  members: Member[];
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const mine = members.find((m) => m.id === ws.user.id)?.tracking === true;
  const on = trackAll || mine;
  const set = (body: { everyone?: boolean; mine?: boolean }) =>
    ws.run(async () => {
      await api(`${ws.prefix}/tracking`, body);
      await ws.reload();
    });
  const decide = (ids: string[] | null, accept: boolean) => ws.editor.current?.decide(ids, accept);
  const justNow = t("dash.justNow");
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-pressed={on}
        title={t("tracked.buttonTitle")}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${on ? "font-medium text-emerald-700 dark:text-emerald-400" : ""}`}
      >
        <PencilLineIcon className="size-3.5" />
        <span className="hidden @2xl:inline">{t(on ? "tracked.buttonOn" : "tracked.button")}</span>
        {changes.length > 0 && (
          <span className="rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 text-white tabular-nums">
            {changes.length}
          </span>
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t("tracked.title")}
        width={380}
        align="end"
      >
        <div className="flex max-h-[min(70vh,560px)] min-h-0 flex-col text-xs">
          <div className="shrink-0 space-y-2 border-b border-border p-3">
            <p className="text-muted">{t("tracked.lead")}</p>
            {ws.canEdit ? (
              <>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={trackAll}
                    disabled={ws.busy}
                    onChange={(e) => set({ everyone: e.target.checked })}
                  />
                  <span>
                    {t("tracked.everyone")}
                    <span className="block text-muted">{t("tracked.everyoneHint")}</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={ws.busy || trackAll}
                    onChange={(e) => set({ mine: e.target.checked })}
                  />
                  <span>
                    {t("tracked.mine")}
                    <span className="block text-muted">
                      {trackAll ? t("tracked.onForEveryone") : t("tracked.mineHint")}
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <p className="text-muted">{t("tracked.readOnly")}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="mr-auto text-muted">
              {changes.length ? t("tracked.inFile", { count: changes.length }) : t("tracked.none")}
            </span>
            {ws.canEdit && changes.length > 0 && (
              <>
                <Btn onClick={() => decide(null, true)}>
                  <CheckIcon className="size-3.5" />
                  {t("tracked.acceptAll")}
                </Btn>
                <Btn
                  onClick={() => {
                    if (confirm(t("tracked.confirmRejectAll", { count: changes.length })))
                      decide(null, false);
                  }}
                >
                  <XIcon className="size-3.5" />
                  {t("tracked.rejectAll")}
                </Btn>
              </>
            )}
          </div>
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain">
            {changes.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-2 border-l-[3px] px-3 py-2"
                style={{ borderLeftColor: `hsl(${userHue(c.author)} 65% 42%)` }}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => ws.editor.current?.revealChange(c.id)}
                >
                  <span className="flex gap-1 text-[11px] text-muted">
                    <span className="truncate">
                      {t(c.kind === "insert" ? "tracked.insertedBy" : "tracked.deletedBy", {
                        name: c.name,
                      })}
                    </span>
                    <span className="ml-auto shrink-0">{ago(c.at, locale, justNow)}</span>
                  </span>
                  <span
                    className={`mt-0.5 block break-all font-mono ${c.kind === "delete" ? "text-red-700 line-through dark:text-red-300" : ""}`}
                  >
                    {deletedText(c.quote, 160)}
                  </span>
                </button>
                {ws.canEdit && (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      title={t("tracked.accept")}
                      aria-label={t("tracked.accept")}
                      onClick={() => decide([c.id], true)}
                      className="border border-border p-1 text-emerald-700 hover:bg-accent-hover dark:text-emerald-400"
                    >
                      <CheckIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("tracked.reject")}
                      aria-label={t("tracked.reject")}
                      onClick={() => decide([c.id], false)}
                      className="border border-border p-1 text-red-700 hover:bg-accent-hover dark:text-red-300"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Popover>
    </>
  );
}
