/**
 * The template gallery, after Overleaf's: the venues' official LaTeX kits, Writer's own templates
 * and those members publish, filtered by kind and field and searched by venue, name or tag. A
 * template's page shows its rendered pages, details and files, and starts a project from it.
 */
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  FilePdfIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  SquaresFourIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Engine,
  type FileInfo,
  type ProjectSummary,
  type PublicUser,
  type TemplateDetail,
  type TemplateInfo,
  type TemplateInput,
  type TemplateList,
  templateCategories,
  templateFields,
} from "../shared/api";
import { api, errorText } from "./api";
import { type MessageKey, useI18n } from "./i18n";
import { LanguageSwitch } from "./language-switch";
import { Modal } from "./modal";
import { useAction } from "./use-action";

type Sort = "recommended" | "newest" | "name";
const ENGINES: Engine[] = ["pdflatex", "xelatex", "lualatex"];

const sizeText = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
/** Previews change only when a template is rebuilt, which changes `updated`. */
const version = (t: TemplateInfo) => `v=${t.updated ?? 0}-${t.previewStatus}`;
const venueText = (t: TemplateInfo) => (t.venue ? `${t.venue}${t.year ? ` ${t.year}` : ""}` : "");
function searchText(t: TemplateInfo) {
  return [
    t.id,
    t.name.zh,
    t.name.en,
    t.description.zh,
    t.description.en,
    t.venue ?? "",
    ...t.venues,
    ...t.tags,
    String(t.year ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}
const canManage = (t: TemplateInfo, user: PublicUser) =>
  t.origin !== "builtin" && (user.admin || (t.origin === "member" && t.author?.id === user.id));

export function TemplateGallery({
  user,
  initial,
  onBack,
  onOpen,
}: {
  user: PublicUser;
  /** A template to show first, from a `/?template=` link. */
  initial: string | null;
  onBack: () => void;
  onOpen: (project: ProjectSummary) => void;
}) {
  const { t, locale: lang } = useI18n();
  const [list, setList] = useState<TemplateList | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("all"),
    [field, setField] = useState("all"),
    [sort, setSort] = useState<Sort>("recommended"),
    [open, setOpen] = useState<string | null>(initial);
  const reload = useCallback(
    () =>
      api<TemplateList>("/templates")
        .then((next) => {
          setList(next);
          setError("");
        })
        .catch((e) => setError(errorText(e))),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  // Previews being built appear without a reload.
  const pending = list?.templates.some((x) => x.previewStatus === "pending");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [pending, reload]);
  useEffect(() => {
    history.replaceState(null, "", open ? `/?template=${encodeURIComponent(open)}` : "/?templates");
  }, [open]);

  const templates = useMemo(() => list?.templates ?? [], [list]);
  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matching = useMemo(() => {
    const found = templates.filter(
      (x) =>
        (category === "all" || x.category === category) &&
        (field === "all" || x.fields.includes(field)) &&
        terms.every((term) => searchText(x).includes(term)),
    );
    if (sort === "name") found.sort((a, b) => a.name[lang].localeCompare(b.name[lang], lang));
    if (sort === "newest")
      found.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.updated ?? 0) - (a.updated ?? 0));
    return found;
  }, [templates, category, field, terms, sort, lang]);
  const count = (key: "category" | "field", value: string) =>
    templates.filter((x) => (key === "category" ? x.category === value : x.fields.includes(value)))
      .length;
  const shown = list?.templates.find((x) => x.id === open);

  return (
    <div className="dash">
      <header className="dash-top">
        <img className="dash-logo" src="/logo-light.svg" alt="Y-Writer" />
        <div className="row">
          <LanguageSwitch />
          <button type="button" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            {t("tpl.back")}
          </button>
        </div>
      </header>
      <div className="dash-body">
        <aside className="dash-side">
          <nav aria-label={t("tpl.categories")}>
            <button
              type="button"
              className={category === "all" ? "selected" : ""}
              aria-current={category === "all" ? "page" : undefined}
              onClick={() => setCategory("all")}
            >
              <SquaresFourIcon aria-hidden="true" />
              <span>{t("tpl.all")}</span>
              <span className="dash-count">{templates.length}</span>
            </button>
            {templateCategories
              .filter((c) => count("category", c))
              .map((c) => (
                <button
                  key={c}
                  type="button"
                  className={category === c ? "selected" : ""}
                  aria-current={category === c ? "page" : undefined}
                  onClick={() => setCategory(c)}
                >
                  <span className="tpl-dot" aria-hidden="true" />
                  <span>{t(`tpl.category.${c}` as MessageKey)}</span>
                  <span className="dash-count">{count("category", c)}</span>
                </button>
              ))}
          </nav>
          <h3 className="tpl-side-title">{t("tpl.fields")}</h3>
          <div className="tpl-chips">
            {["all", ...templateFields.filter((f) => count("field", f))].map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={field === f}
                className={field === f ? "selected" : ""}
                onClick={() => setField(f)}
              >
                {f === "all" ? t("tpl.anyField") : t(`tpl.field.${f}` as MessageKey)}
              </button>
            ))}
          </div>
        </aside>
        <main className="dash-main">
          <section className="tpl-intro">
            <h1>{t("tpl.title")}</h1>
            <p className="muted">{t("tpl.lead")}</p>
          </section>
          <div className="dash-toolbar tpl-toolbar">
            <label className="dash-search">
              <MagnifyingGlassIcon aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t("tpl.search")}
                aria-label={t("tpl.search")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="tpl-sort">
              {t("tpl.sortLabel")}
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="recommended">{t("tpl.sort.recommended")}</option>
                <option value="newest">{t("tpl.sort.newest")}</option>
                <option value="name">{t("tpl.sort.name")}</option>
              </select>
            </label>
            <span className="muted">{t("tpl.count", { count: matching.length })}</span>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {list && !list.library.available && <p className="notice">{t("tpl.libraryMissing")}</p>}
          {!list && !error && <p className="muted">{t("common.loading")}</p>}
          {list && !matching.length && <p className="muted">{t("tpl.none")}</p>}
          <div className="tpl-grid">
            {matching.map((x) => (
              <TemplateCard key={x.id} template={x} onOpen={() => setOpen(x.id)} />
            ))}
          </div>
        </main>
      </div>
      {open && (
        <TemplatePage
          id={open}
          summary={shown}
          user={user}
          onClose={() => setOpen(null)}
          onOpen={onOpen}
          onChanged={(gone) => {
            if (gone) setOpen(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function TemplateCard({ template: x, onOpen }: { template: TemplateInfo; onOpen: () => void }) {
  const { t, locale: lang } = useI18n();
  return (
    <button type="button" className="tpl-card" onClick={onOpen}>
      <span className="tpl-thumb">
        {x.preview ? (
          <img src={`/api/templates/${x.id}/preview?${version(x)}`} alt="" loading="lazy" />
        ) : (
          <FileTextIcon aria-hidden="true" />
        )}
        {x.previewStatus === "pending" && <span className="tpl-flag">{t("tpl.pending")}</span>}
        {x.previewStatus === "failed" && <span className="tpl-flag failed">{t("tpl.failed")}</span>}
      </span>
      <span className="tpl-card-body">
        <span className="tpl-badges">
          {venueText(x) && <span className="tpl-venue">{venueText(x)}</span>}
          <span className={`tpl-origin ${x.origin}`}>{t(`tpl.origin.${x.origin}`)}</span>
        </span>
        <strong>{x.name[lang]}</strong>
        <span className="muted tpl-desc">{x.description[lang]}</span>
      </span>
    </button>
  );
}

/** One template: its pages beside its details, files and actions. */
function TemplatePage({
  id,
  summary,
  user,
  onClose,
  onOpen,
  onChanged,
}: {
  id: string;
  summary: TemplateInfo | undefined;
  user: PublicUser;
  onClose: () => void;
  onOpen: (project: ProjectSummary) => void;
  onChanged: (gone: boolean) => void;
}) {
  const { t, locale: lang } = useI18n();
  const [detail, setDetail] = useState<TemplateDetail | null>(null),
    [loadError, setLoadError] = useState(""),
    [name, setName] = useState(""),
    [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  // The listing polls while a preview builds; follow it.
  const stamp = summary ? `${summary.updated}-${summary.previewStatus}-${summary.name.zh}` : "";
  useEffect(() => {
    void stamp;
    api<TemplateDetail>(`/templates/${id}`)
      .then((next) => {
        setDetail(next);
        setName((current) => current || next.name[lang]);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [id, lang, stamp]);
  const title = detail?.name[lang] ?? summary?.name[lang] ?? t("tpl.title");
  if (editing && detail)
    return (
      <TemplateForm
        title={t("tpl.editTitle")}
        initial={detail}
        submit={t("tpl.save")}
        onClose={() => setEditing(false)}
        onSubmit={async (input) => {
          await api(`/templates/${id}`, input, "PATCH");
          setEditing(false);
          onChanged(false);
        }}
      />
    );
  const pages = detail ? Math.max(detail.pages, detail.preview ? 1 : 0) : 0;
  return (
    <Modal title={title} onClose={onClose} wide>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {detail && (
        <div className="tpl-detail">
          <div className="tpl-pages">
            {detail.previewStatus === "pending" && <p className="notice">{t("tpl.pendingLead")}</p>}
            {pages ? (
              Array.from({ length: pages }, (_, i) => i + 1).map((page) => (
                <img
                  key={page}
                  src={
                    detail.pages
                      ? `/api/templates/${id}/pages/${page}?${version(detail)}`
                      : `/api/templates/${id}/preview?${version(detail)}`
                  }
                  alt={t("tpl.pageAlt", { page })}
                  loading="lazy"
                />
              ))
            ) : (
              <div className="tpl-no-preview">
                <FileTextIcon aria-hidden="true" />
                <span className="muted">
                  {detail.previewStatus === "failed" ? t("tpl.failed") : t("tpl.noPreview")}
                </span>
              </div>
            )}
          </div>
          <div className="tpl-info">
            <div className="tpl-badges">
              {venueText(detail) && <span className="tpl-venue">{venueText(detail)}</span>}
              <span className={`tpl-origin ${detail.origin}`}>
                {t(`tpl.origin.${detail.origin}`)}
              </span>
            </div>
            <p>{detail.description[lang]}</p>
            <form
              className="tpl-use"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () =>
                  onOpen(
                    await api<ProjectSummary>("/projects", { name: name.trim(), template: id }),
                  ),
                );
              }}
            >
              <label>
                {t("tpl.projectName")}
                <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <button className="primary" type="submit" disabled={busy || !name.trim()}>
                {busy ? t("common.working") : t("tpl.use")}
              </button>
            </form>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <dl className="tpl-facts">
              {detail.venues.length > 0 && (
                <>
                  <dt>{t("tpl.alsoFor")}</dt>
                  <dd>{detail.venues.join(", ")}</dd>
                </>
              )}
              {detail.fields.length > 0 && (
                <>
                  <dt>{t("tpl.fields")}</dt>
                  <dd>{detail.fields.map((f) => t(`tpl.field.${f}` as MessageKey)).join(" · ")}</dd>
                </>
              )}
              <dt>{t("tpl.category")}</dt>
              <dd>{t(`tpl.category.${detail.category}` as MessageKey)}</dd>
              <dt>{t("tpl.engine")}</dt>
              <dd>{detail.engine}</dd>
              <dt>{t("tpl.main")}</dt>
              <dd>
                <code>{detail.main}</code>
              </dd>
              <dt>{t("tpl.files")}</dt>
              <dd>
                {t("tpl.filesValue", { count: detail.fileCount, size: sizeText(detail.bytes) })}
              </dd>
              {detail.updated && (
                <>
                  <dt>{t("tpl.updated")}</dt>
                  <dd>
                    {new Date(detail.updated).toLocaleDateString(lang === "zh" ? "zh-CN" : "en")}
                  </dd>
                </>
              )}
              {detail.author && (
                <>
                  <dt>{t("tpl.author")}</dt>
                  <dd>{detail.author.name}</dd>
                </>
              )}
              {detail.tags.length > 0 && (
                <>
                  <dt>{t("tpl.tags")}</dt>
                  <dd>{detail.tags.join(", ")}</dd>
                </>
              )}
            </dl>
            <div className="tpl-links">
              {detail.pdf && (
                <a
                  href={`/api/templates/${id}/pdf?${version(detail)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FilePdfIcon aria-hidden="true" />
                  {t("tpl.pdf")}
                </a>
              )}
              {detail.homepage && (
                <a href={detail.homepage} target="_blank" rel="noreferrer">
                  <ArrowSquareOutIcon aria-hidden="true" />
                  {t("tpl.homepage")}
                </a>
              )}
              {detail.source && (
                <a href={detail.source} target="_blank" rel="noreferrer">
                  <ArrowSquareOutIcon aria-hidden="true" />
                  {t("tpl.source")}
                </a>
              )}
            </div>
            <details>
              <summary>{t("tpl.showFiles")}</summary>
              <ul className="tpl-files">
                {detail.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                    <span className="muted">{sizeText(f.bytes)}</span>
                  </li>
                ))}
              </ul>
            </details>
            {detail.previewLog && canManage(detail, user) && (
              <details>
                <summary>{t("tpl.showLog")}</summary>
                <pre className="tpl-log">{detail.previewLog}</pre>
              </details>
            )}
            {canManage(detail, user) && (
              <div className="tpl-manage">
                <button type="button" onClick={() => setEditing(true)}>
                  <PencilSimpleIcon aria-hidden="true" />
                  {t("tpl.edit")}
                </button>
                <button
                  type="button"
                  disabled={busy || detail.previewStatus === "pending"}
                  onClick={() =>
                    run(async () => {
                      await api(`/templates/${id}/render`, {});
                      onChanged(false);
                    })
                  }
                >
                  <ArrowClockwiseIcon aria-hidden="true" />
                  {t("tpl.rebuild")}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(t("tpl.deleteConfirm", { name: detail.name[lang] }))) return;
                    run(async () => {
                      await api(`/templates/${id}`, {}, "DELETE");
                      onChanged(true);
                    });
                  }}
                >
                  <TrashIcon aria-hidden="true" />
                  {t("tpl.delete")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The details a template is listed with; publishing also picks the main file and engine. */
function TemplateForm({
  title,
  lead,
  initial,
  submit,
  mains,
  onSubmit,
  onClose,
}: {
  title: string;
  lead?: string;
  initial: Partial<TemplateInput>;
  submit: string;
  /** The project's .tex files, when publishing. */
  mains?: string[];
  onSubmit: (input: TemplateInput & { main?: string; engine?: Engine }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { busy, error, run } = useAction();
  const [nameZh, setNameZh] = useState(initial.name?.zh ?? ""),
    [nameEn, setNameEn] = useState(
      initial.name?.en && initial.name.en !== initial.name.zh ? initial.name.en : "",
    ),
    [descZh, setDescZh] = useState(initial.description?.zh ?? ""),
    [descEn, setDescEn] = useState(
      initial.description?.en && initial.description.en !== initial.description.zh
        ? initial.description.en
        : "",
    ),
    [category, setCategory] = useState(initial.category ?? "paper"),
    [fields, setFields] = useState<string[]>(initial.fields ?? []),
    [venue, setVenue] = useState(initial.venue ?? ""),
    [year, setYear] = useState(initial.year ? String(initial.year) : ""),
    [tags, setTags] = useState((initial.tags ?? []).join(", ")),
    [main, setMain] = useState(mains?.includes("main.tex") ? "main.tex" : (mains?.[0] ?? "")),
    [engine, setEngine] = useState<Engine>("pdflatex");
  const ready = !!(nameZh.trim() || nameEn.trim()) && (!mains || !!main);
  return (
    <Modal title={title} onClose={onClose} wide>
      <form
        className="tpl-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          run(() =>
            onSubmit({
              name: { zh: nameZh.trim(), en: nameEn.trim() },
              description: { zh: descZh.trim(), en: descEn.trim() },
              category,
              fields,
              tags: tags
                .split(/[,，]/)
                .map((x) => x.trim())
                .filter(Boolean),
              venue: venue.trim() || null,
              year: year.trim() ? Number(year) : null,
              ...(mains ? { main, engine } : {}),
            }),
          );
        }}
      >
        {lead && <p className="muted">{lead}</p>}
        {mains && !mains.length && <p className="error">{t("tpl.noTex")}</p>}
        <div className="tpl-form-grid">
          <label>
            {t("tpl.nameZh")}
            <input value={nameZh} maxLength={120} onChange={(e) => setNameZh(e.target.value)} />
          </label>
          <label>
            {t("tpl.nameEn")}
            <input value={nameEn} maxLength={120} onChange={(e) => setNameEn(e.target.value)} />
          </label>
          <label className="wide">
            {t("tpl.descriptionZh")}
            <textarea
              rows={3}
              maxLength={2000}
              value={descZh}
              onChange={(e) => setDescZh(e.target.value)}
            />
          </label>
          <label className="wide">
            {t("tpl.descriptionEn")}
            <textarea
              rows={2}
              maxLength={2000}
              value={descEn}
              onChange={(e) => setDescEn(e.target.value)}
            />
          </label>
          <label>
            {t("tpl.category")}
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {templateCategories
                .filter((c) => c !== "basic")
                .map((c) => (
                  <option key={c} value={c}>
                    {t(`tpl.category.${c}` as MessageKey)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t("tpl.venueLabel")}
            <input
              value={venue}
              maxLength={40}
              placeholder="NeurIPS"
              onChange={(e) => setVenue(e.target.value)}
            />
          </label>
          <label>
            {t("tpl.yearLabel")}
            <input
              value={year}
              inputMode="numeric"
              maxLength={4}
              placeholder={String(new Date().getFullYear())}
              onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <label>
            {t("tpl.tagsLabel")}
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <fieldset className="wide tpl-field-picks">
            <legend>{t("tpl.fields")}</legend>
            {templateFields.map((f) => (
              <label key={f} className="check">
                <input
                  type="checkbox"
                  checked={fields.includes(f)}
                  onChange={(e) =>
                    setFields((current) =>
                      e.target.checked ? [...current, f] : current.filter((x) => x !== f),
                    )
                  }
                />
                {t(`tpl.field.${f}` as MessageKey)}
              </label>
            ))}
          </fieldset>
          {mains && (
            <>
              <label>
                {t("tpl.main")}
                <select value={main} onChange={(e) => setMain(e.target.value)}>
                  {mains.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("tpl.engine")}
                <select value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
                  {ENGINES.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="primary" type="submit" disabled={busy || !ready}>
            {busy ? t("common.working") : submit}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** Publishes a project's current files as a template, then shows it in the gallery. */
export function PublishTemplateDialog({
  project,
  onClose,
  onDone,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onDone: (template: TemplateInfo) => void;
}) {
  const { t } = useI18n();
  const [mains, setMains] = useState<string[] | null>(null),
    [loadError, setLoadError] = useState("");
  useEffect(() => {
    api<FileInfo[]>(`/projects/${project.id}/files`)
      .then((files) => setMains(files.filter((f) => f.path.endsWith(".tex")).map((f) => f.path)))
      .catch((e) => setLoadError(errorText(e)));
  }, [project.id]);
  if (!mains)
    return (
      <Modal title={t("tpl.publishTitle")} onClose={onClose}>
        <p className={loadError ? "error" : "muted"}>{loadError || t("common.loading")}</p>
      </Modal>
    );
  return (
    <TemplateForm
      title={t("tpl.publishTitle")}
      lead={t("tpl.publishLead")}
      initial={{ name: { zh: project.name, en: "" } }}
      submit={t("tpl.publishSubmit")}
      mains={mains}
      onClose={onClose}
      onSubmit={async (input) =>
        onDone(await api<TemplateInfo>(`/projects/${project.id}/template`, input))
      }
    />
  );
}
