/** Word count of the main document and the files it includes, as Overleaf shows it. */
import { useEffect, useState } from "react";
import type { SourceFile } from "../../shared/api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Dialog } from "./ui";
import { wordCount } from "./word-count";

export function WordCountDialog({
  ws,
  main,
  sources: initial,
  refresh,
  onClose,
}: {
  ws: WorkspaceContext;
  /** The main file's path. */
  main: string;
  sources: SourceFile[];
  /** Reads every file again, for collaborators' latest changes. */
  refresh: () => Promise<SourceFile[]>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState(initial);
  useEffect(() => {
    void refresh()
      .then(setSources)
      .catch(() => {});
  }, [refresh]);
  // The open file as it is in the editor now; the others as last saved.
  const open = ws.file && !ws.file.binary ? ws.editor.current?.text() : undefined;
  const read = (path: string) =>
    open !== undefined && ws.file?.path === path
      ? open
      : (sources.find((f) => f.path === path)?.content ?? null);
  const total = main ? wordCount(main, read) : null;
  const current =
    open !== undefined && ws.file && ws.file.path !== main && ws.file.path.endsWith(".tex")
      ? wordCount(ws.file.path, read)
      : null;
  const rows = (c: NonNullable<typeof total>) => [
    [t("count.words"), c.words],
    [t("count.characters"), c.characters],
    [t("count.headers"), `${c.headers} · ${t("count.wordsIn", { count: c.headerWords })}`],
    [t("count.captions"), `${c.captions} · ${t("count.wordsIn", { count: c.captionWords })}`],
    [t("count.inlineMath"), c.inlineMath],
    [t("count.displayMath"), c.displayMath],
  ];
  const table = (c: NonNullable<typeof total>) => (
    <table className="w-full text-xs">
      <tbody>
        {rows(c).map(([label, value]) => (
          <tr key={String(label)} className="border-b border-border last:border-0">
            <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted">
              {label}
            </th>
            <td className="py-1.5 text-right tabular-nums">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <Dialog title={t("count.title")} onClose={onClose}>
      {!total ? (
        <p className="text-muted">{t("build.noTex")}</p>
      ) : (
        <div className="space-y-4">
          <section>
            <h3 className="mb-1 font-medium">
              {t("count.document", { path: main })}
              {total.files.length > 1 && (
                <span className="ml-1 font-normal text-muted">
                  {t("count.included", { count: total.files.length - 1 })}
                </span>
              )}
            </h3>
            <p className="mb-2 text-lg font-semibold tabular-nums">
              {t("count.summary", { words: total.words, characters: total.characters })}
            </p>
            {table(total)}
          </section>
          {current && ws.file && (
            <section>
              <h3 className="mb-1 font-medium">{t("count.thisFile", { path: ws.file.path })}</h3>
              {table(current)}
            </section>
          )}
          <p className="text-[11px] text-muted">{t("count.note")}</p>
        </div>
      )}
    </Dialog>
  );
}
