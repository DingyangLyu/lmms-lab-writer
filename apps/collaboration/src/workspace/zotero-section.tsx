/**
 * Zotero in the references dialog: connect an account with an API key, import a library's or
 * collection's new entries into a .bib file, or link a .bib file to it and update it later.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  BibliographyImport,
  FileContent,
  ZoteroAccount,
  ZoteroCollection,
  ZoteroLibrary,
  ZoteroLink,
  ZoteroSync,
} from "../../shared/api";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import type { WorkspaceContext } from "./context";
import { Btn, Input, Select } from "./ui";

const KEY_PAGE = "https://www.zotero.org/settings/keys/new";

export function ZoteroSection({
  ws,
  bibFile,
  refreshSources,
}: {
  ws: WorkspaceContext;
  /** The .bib file chosen above, which "import new entries" adds to. */
  bibFile: string;
  refreshSources: () => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const { prefix, canEdit, busy, run, report } = ws;
  const [account, setAccount] = useState<ZoteroAccount | null>(null),
    [key, setKey] = useState(""),
    [libraries, setLibraries] = useState<ZoteroLibrary[]>([]),
    [library, setLibrary] = useState(""),
    [collections, setCollections] = useState<ZoteroCollection[]>([]),
    [collection, setCollection] = useState(""),
    [links, setLinks] = useState<ZoteroLink[]>([]);
  const loadLinks = useCallback(
    () =>
      api<ZoteroLink[]>(`${prefix}/zotero`)
        .then(setLinks)
        .catch((e) => report(errorText(e))),
    [prefix, report],
  );
  useEffect(() => {
    void api<ZoteroAccount>("/me/zotero")
      .then(setAccount)
      .catch((e) => report(errorText(e)));
    void loadLinks();
  }, [loadLinks, report]);
  useEffect(() => {
    setLibraries([]);
    if (!account?.username) return;
    void api<ZoteroLibrary[]>("/me/zotero/libraries")
      .then((list) => {
        setLibraries(list);
        setLibrary((old) => (list.some((l) => l.id === old) ? old : (list[0]?.id ?? "")));
      })
      .catch((e) => report(errorText(e)));
  }, [account, report]);
  useEffect(() => {
    setCollections([]);
    setCollection("");
    if (!library) return;
    void api<ZoteroCollection[]>(`/me/zotero/collections?library=${encodeURIComponent(library)}`)
      .then(setCollections)
      .catch((e) => report(errorText(e)));
  }, [library, report]);

  const libraryName = (name: string, owner?: string) =>
    name || (owner ? t("zotero.libraryOf", { name: owner }) : t("zotero.myLibrary"));
  const chosen = {
    library,
    libraryName: libraries.find((l) => l.id === library)?.name ?? "",
    collection,
    collectionName: collections.find((c) => c.key === collection)?.name ?? "",
  };
  const synced = (result: ZoteroSync) =>
    ws.notify(
      t(result.changed ? "zotero.updated" : "zotero.unchanged", {
        path: result.path,
        count: result.items,
      }),
    );
  const when = (ms: number) => new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en");

  if (!account) return null;
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <h3 className="text-xs font-semibold">Zotero</h3>
      {!account.username ? (
        <>
          <p className="text-xs text-muted">
            {t("zotero.intro")}{" "}
            <a href={KEY_PAGE} target="_blank" rel="noreferrer" className="underline">
              {t("zotero.createKey")}
            </a>
          </p>
          <div className="flex gap-2">
            <Input
              aria-label={t("zotero.key")}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("zotero.key")}
              className="min-w-0 flex-1"
            />
            <Btn
              disabled={busy || !key.trim()}
              onClick={() =>
                run(async () => {
                  setAccount(await api<ZoteroAccount>("/me/zotero", { key: key.trim() }));
                  setKey("");
                })
              }
            >
              {t("zotero.connect")}
            </Btn>
          </div>
        </>
      ) : (
        <>
          <p className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="truncate">{t("zotero.connectedAs", { name: account.username })}</span>
            <button
              type="button"
              className="shrink-0 hover:text-accent"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("/me/zotero/remove", {});
                  setAccount({ username: null });
                  await loadLinks();
                })
              }
            >
              {t("zotero.disconnect")}
            </button>
          </p>
          <Select
            aria-label={t("zotero.library")}
            value={library}
            onChange={(e) => setLibrary(e.target.value)}
            className="w-full"
          >
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {libraryName(l.name)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("zotero.collection")}
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            className="w-full"
          >
            <option value="">{t("zotero.wholeLibrary")}</option>
            {collections.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap gap-2">
            <Btn
              disabled={!canEdit || busy || !library || !bibFile}
              title={bibFile ? undefined : t("bib.choose")}
              onClick={() =>
                run(async () => {
                  const { bibtex } = await api<{ bibtex: string }>(`${prefix}/zotero/export`, {
                    library,
                    collection,
                  });
                  const current = await api<FileContent>(`${prefix}/files/${bibFile}`);
                  const result = await api<BibliographyImport>(`${prefix}/bibliography/import`, {
                    file: bibFile,
                    expected: "content" in current ? current.content : "",
                    bibtex,
                  });
                  ws.notify(
                    t("bib.imported", { added: result.added, skipped: result.skipped.length }),
                  );
                  await refreshSources();
                })
              }
            >
              {t("zotero.importNew")}
            </Btn>
            <Btn
              disabled={!canEdit || busy || !library}
              onClick={() => {
                const path = prompt(t("zotero.linkPrompt"), "zotero.bib")?.trim();
                if (path)
                  run(async () => {
                    synced(await api<ZoteroSync>(`${prefix}/zotero/link`, { ...chosen, path }));
                    await Promise.all([loadLinks(), refreshSources()]);
                  });
              }}
            >
              {t("zotero.link")}
            </Btn>
          </div>
        </>
      )}
      {links.map((link) => (
        <article key={link.file} className="space-y-1 border border-border p-2 text-xs">
          <p className="break-all font-medium">{link.path}</p>
          <p className="text-muted">
            {libraryName(link.libraryName, link.ownerName)}
            {link.collectionName ? ` / ${link.collectionName}` : ""}
            {" · "}
            {t("zotero.linkState", { count: link.items, time: when(link.synced) })}
          </p>
          {!link.ownerConnected && (
            <p className="text-red-600">
              {t("zotero.ownerDisconnected", { name: link.ownerName })}
            </p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              className="hover:text-accent disabled:text-muted"
              disabled={!canEdit || busy || !link.ownerConnected}
              onClick={() =>
                run(async () => {
                  synced(await api<ZoteroSync>(`${prefix}/zotero/refresh`, { file: link.file }));
                  await Promise.all([loadLinks(), refreshSources()]);
                })
              }
            >
              {t("zotero.update")}
            </button>
            <button
              type="button"
              className="hover:text-accent disabled:text-muted"
              disabled={!canEdit || busy}
              onClick={() =>
                run(async () => {
                  await api(`${prefix}/zotero/unlink`, { file: link.file });
                  await loadLinks();
                })
              }
            >
              {t("zotero.unlink")}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
