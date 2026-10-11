/**
 * The product homepage, as Overleaf has one: what Y-Writer is, shown rather than told. A dark
 * hero with a working picture of the editor (LaTeX typed, the PDF filling in, a colleague's
 * cursor, a note naming someone, the AI answering), then each part of the product with its own
 * small moving scene, the template library, three steps, questions and a way in. Sections rise
 * in as they are scrolled to; nothing moves for readers who asked for less motion.
 */
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  AtIcon,
  BellIcon,
  CaretDownIcon,
  ChatsCircleIcon,
  CheckIcon,
  ClockCounterClockwiseIcon,
  CloudArrowUpIcon,
  DatabaseIcon,
  DesktopIcon,
  FilesIcon,
  GearSixIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  RobotIcon,
  ShieldCheckIcon,
  SparkleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import "./landing.css";

/** The official kits of the template library. */
const VENUES = [
  "NeurIPS 2026",
  "ICML 2026",
  "ICLR 2027",
  "AAAI 2027",
  "IJCAI-ECAI 2026",
  "CVPR 2026",
  "ICCV 2025",
  "ECCV 2026",
  "WACV 2027",
  "BMVC 2026",
  "ACL ARR",
  "COLM 2026",
  "AISTATS 2027",
  "UAI 2026",
  "COLT 2026",
  "ACM SIGCONF",
  "ICASSP 2027",
  "IEEE RAS",
  "Springer LNCS",
  "TMLR",
  "JMLR",
  "IEEE TPAMI",
  "arXiv",
];

const still = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Sections marked `data-reveal` rise in the first time they come into view. */
function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const scope = root.current;
    if (!scope) return;
    const targets = scope.querySelectorAll<HTMLElement>("[data-reveal]");
    if (still() || typeof IntersectionObserver === "undefined") {
      for (const t of targets) t.classList.add("is-in");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    for (const t of targets) observer.observe(t);
    return () => observer.disconnect();
  }, [root]);
}

/** A number counting up once it is seen. */
function Count({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(still() ? to : 0);
  useEffect(() => {
    const element = ref.current;
    if (!element || still()) return;
    let frame = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / 1200);
        setShown(Math.round(to * (1 - (1 - p) ** 3)));
        if (p < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [to]);
  return (
    <span ref={ref}>
      {shown}
      {suffix}
    </span>
  );
}

/** A clock in steps of `ms`, wrapping at `end`: drives a scene. */
function useClock(ms: number, end: number, rest: number) {
  const [at, setAt] = useState(() => (still() ? rest : 0));
  useEffect(() => {
    if (still()) return;
    const timer = setInterval(() => setAt((n) => (n >= end ? 0 : n + 1)), ms);
    return () => clearInterval(timer);
  }, [ms, end]);
  return at;
}

const SOURCE = [
  "\\section{Results}",
  "We measure the activation",
  "barrier $E_a$ of the electrolyte",
  "interface~\\cite{wang2024}.",
  "\\begin{equation}",
  "  k = A\\,e^{-E_a/RT}",
  "\\end{equation}",
];
const TYPED = SOURCE.join("\n").length;

function Code({ text }: { text: string }) {
  const parts: Array<{ at: number; text: string; kind: string }> = [];
  const pattern = /(\\[A-Za-z]+|\\,|\{[^}]*\}?|\$[^$]*\$?|~)/g;
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > last) parts.push({ at: last, text: text.slice(last, found.index), kind: "" });
    const token = found[0];
    parts.push({
      at: found.index,
      text: token,
      kind:
        token.startsWith("\\") || token === "~" ? "cmd" : token.startsWith("$") ? "math" : "arg",
    });
    last = found.index + token.length;
  }
  if (last < text.length) parts.push({ at: last, text: text.slice(last), kind: "" });
  return (
    <>
      {parts.map((p) => (
        <span key={p.at} className={p.kind ? `ld-${p.kind}` : undefined}>
          {p.text}
        </span>
      ))}
    </>
  );
}

/** The editor at work, drawn at a fixed size and scaled to fit. */
function HeroDemo() {
  const { t } = useI18n();
  const NOTE = TYPED + 20,
    ASK = TYPED + 40,
    THINK = TYPED + 52,
    REPLY = TYPED + 82,
    KEEP = TYPED + 118,
    END = TYPED + 150;
  const at = useClock(40, END, KEEP + 5);
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setScale(Math.min(1, (entry?.contentRect.width ?? 1120) / 1120)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  let left = at;
  const lines = SOURCE.map((line) => {
    const shown = line.slice(0, Math.max(0, left));
    left -= line.length + 1;
    return shown;
  });
  const done = (line: number) => (lines[line]?.length ?? 0) >= (SOURCE[line]?.length ?? 0);
  const typing = lines.findIndex((line, i) => line.length < (SOURCE[i]?.length ?? 0));
  const compiling = at > TYPED && at < TYPED + 12;
  return (
    <div ref={frame} className="ld-demo-frame" style={{ height: 600 * scale }} aria-hidden="true">
      <div
        className={`ld-demo ${at > END - 6 ? "is-fading" : ""}`}
        style={{ transform: `scale(${scale})` }}
      >
        <div className="ld-demo-bar">
          <span className="ld-lights">
            <i />
            <i />
            <i />
          </span>
          <strong>Y-Writer</strong>
          <span className="ld-sep">/</span>
          <span>{t("land.demo.project")}</span>
          <span className="ld-saved">● {t("land.demo.saved")}</span>
          <span className="ld-online">
            <span className="ld-face" style={{ background: "#7c3aed" }}>
              A
            </span>
            <span className="ld-face" style={{ background: "#0ea5e9" }}>
              W
            </span>
            <span className="ld-face" style={{ background: "#f97316" }}>
              C
            </span>
            {t("land.demo.online")}
          </span>
          <span className={`ld-compile ${compiling ? "is-busy" : ""}`}>
            <PlayIcon weight="fill" />
            {compiling ? t("land.demo.compiling") : t("land.demo.compile")}
          </span>
        </div>
        <div className="ld-demo-body">
          <nav className="ld-rail">
            <FilesIcon className="is-on" />
            <MagnifyingGlassIcon />
            <ChatsCircleIcon />
            <ClockCounterClockwiseIcon />
            <span className="ld-grow" />
            <span className="ld-bell">
              <BellIcon />
              {at > NOTE && <i />}
            </span>
            <GearSixIcon />
          </nav>
          <div className="ld-editor">
            <div className="ld-tab">main.tex</div>
            {SOURCE.map((line, i) => (
              <div key={line} className="ld-line">
                <span className="ld-num">{i + 1}</span>
                <span className="ld-code">
                  {i === 1 && at > NOTE ? (
                    <>
                      <Code text={(lines[i] ?? "").slice(0, 15)} />
                      <mark className="ld-noted">{(lines[i] ?? "").slice(15)}</mark>
                    </>
                  ) : (
                    <Code text={lines[i] ?? ""} />
                  )}
                  {i === typing && <span className="ld-caret" />}
                  {i === 2 && at > 30 && (
                    <span className="ld-peer">
                      <span>Wang</span>
                    </span>
                  )}
                  {i === 5 && at > 60 && (
                    <span className="ld-peer ld-peer-c">
                      <span>Chen</span>
                    </span>
                  )}
                </span>
              </div>
            ))}
            {at > NOTE && (
              <div className="ld-note-card">
                <div className="ld-note-head">
                  <span className="ld-face" style={{ background: "#7c3aed" }}>
                    A
                  </span>
                  <b>Ann</b>
                </div>
                <div className="ld-note-quote">activation barrier</div>
                <div>
                  <span className="ld-at">@Wang</span> {t("land.demo.note")}
                </div>
              </div>
            )}
          </div>
          <div className="ld-pdf">
            <div className="ld-page">
              {done(0) && <div className="ld-h ld-ink">2&nbsp;&nbsp; Results</div>}
              {done(1) && (
                <p className="ld-p ld-ink">
                  We measure the{" "}
                  <mark className={at > NOTE ? "ld-hl is-on" : "ld-hl"}>activation barrier</mark>
                  {done(2) && (
                    <>
                      {" "}
                      <i>E</i>
                      <sub>a</sub> of the electrolyte
                    </>
                  )}
                  {done(3) && <> interface [1].</>}
                </p>
              )}
              {done(6) && !compiling && (
                <div className="ld-eq ld-ink">
                  <span>
                    <i>k</i> = <i>A</i> e
                    <sup>
                      −<i>E</i>a/<i>RT</i>
                    </sup>
                  </span>
                  <span>(1)</span>
                </div>
              )}
              {!done(0) && (
                <>
                  <div className="ld-skel" />
                  <div className="ld-skel short" />
                </>
              )}
              {at > NOTE && <span className="ld-pin" />}
            </div>
          </div>
          <aside className="ld-ai">
            <div className="ld-ai-head">
              <RobotIcon /> Codex
            </div>
            <div className="ld-chat">
              {at > ASK && <div className="ld-msg me">{t("land.demo.ask")}</div>}
              {at > THINK && at <= REPLY && (
                <div className="ld-msg bot ld-dots">
                  <i />
                  <i />
                  <i />
                </div>
              )}
              {at > REPLY && (
                <div className="ld-msg bot">
                  {t("land.demo.reply")}
                  <div className="ld-diff">
                    <div className="del">- We measure the activation barrier of the</div>
                    <div className="add">+ We measure the activation barrier $E_a$ of the</div>
                    <div className="add">+ interface~\cite{"{wang2024}"}.</div>
                  </div>
                  {at > KEEP && (
                    <div className="ld-kept">
                      <CheckIcon weight="bold" /> {t("land.demo.accept")}
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
        {at > NOTE + 6 && at < END - 20 && (
          <div className="ld-toast">
            <AtIcon weight="bold" />
            {t("land.demo.toast")}
          </div>
        )}
      </div>
    </div>
  );
}

/** Several people typing in one document, with a tracked insertion and deletion. */
function CollabVisual() {
  return (
    <div className="ld-visual ld-collab" aria-hidden="true">
      <div className="ld-mini-bar">
        <span className="ld-face" style={{ background: "#7c3aed" }}>
          A
        </span>
        <span className="ld-face" style={{ background: "#0ea5e9" }}>
          W
        </span>
        <span className="ld-face" style={{ background: "#f97316" }}>
          C
        </span>
        <span className="ld-live">LIVE</span>
      </div>
      <div className="ld-mini-text">
        <p>
          Lithium dendrites grow when the <span className="ld-del">local current</span>
          <span className="ld-ins">current density</span> exceeds a threshold.
          <span className="ld-cursor c1">
            <b>Ann</b>
          </span>
        </p>
        <p>
          We model the interface with a phase-field approach
          <span className="ld-cursor c2">
            <b>Wang</b>
          </span>{" "}
          and calibrate it against cryo-EM images.
        </p>
        <p>
          The predicted onset agrees with experiment within 8%
          <span className="ld-cursor c3">
            <b>Chen</b>
          </span>
          .
        </p>
      </div>
    </div>
  );
}

/** Note cards arriving, and the bell. */
function NotesVisual() {
  const { t } = useI18n();
  return (
    <div className="ld-visual ld-notes" aria-hidden="true">
      <div className="ld-bell-big">
        <BellIcon weight="fill" />
        <i>2</i>
      </div>
      {[
        ["#7c3aed", "Ann", "activation barrier", "@Wang", t("land.demo.note")],
        ["#0ea5e9", "Wang", "phase-field approach", "@Chen", "cite the 2023 benchmark?"],
        ["#f97316", "Chen", "within 8%", "@Ann", "add error bars here"],
      ].map(([color, name, quote, at, body], i) => (
        <div key={name} className="ld-card" style={{ animationDelay: `${0.35 + i * 0.55}s` }}>
          <div className="ld-note-head">
            <span className="ld-face" style={{ background: color }}>
              {name?.slice(0, 1)}
            </span>
            <b>{name}</b>
            <span className="ld-time">{i ? `${i * 3} min` : "now"}</span>
          </div>
          <div className="ld-note-quote">{quote}</div>
          <div>
            <span className="ld-at">{at}</span> {body}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A conversation with the AI and its edit. */
function AiVisual() {
  const { t } = useI18n();
  return (
    <div className="ld-visual ld-aiv" aria-hidden="true">
      <div className="ld-ai-tabs">
        <span className="on">Codex</span>
        <span>Claude Code</span>
        <span>OpenCode</span>
      </div>
      <div className="ld-msg me">{t("land.demo.ask")}</div>
      <div className="ld-msg bot">
        <div className="ld-tool">
          <SparkleIcon weight="fill" /> search_literature("activation barrier electrolyte")
        </div>
        <div className="ld-tool">
          <SparkleIcon weight="fill" /> edit main.tex · 2 changes
        </div>
        {t("land.demo.reply")}
        <div className="ld-diff">
          <div className="del">- It is known that the barrier is low.</div>
          <div className="add">+ The barrier is low~\cite{"{wang2024}"}.</div>
        </div>
      </div>
    </div>
  );
}

/** A source line and the PDF block it makes, joined. */
function SyncVisual() {
  return (
    <div className="ld-visual ld-sync" aria-hidden="true">
      <div className="ld-sync-src">
        {[
          "\\section{Method}",
          "We solve the",
          "Poisson–Nernst–Planck",
          "equations on a",
          "graded mesh.",
        ].map((line, i) => (
          <div key={line} className={i === 2 || i === 3 ? "ld-line is-hit" : "ld-line"}>
            <span className="ld-num">{i + 41}</span>
            <span className="ld-code">
              <Code text={line} />
            </span>
          </div>
        ))}
      </div>
      <svg
        className="ld-sync-link"
        viewBox="0 0 80 120"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M0 60 C 40 60, 40 40, 80 40" />
      </svg>
      <div className="ld-sync-pdf">
        <div className="ld-h">3&nbsp; Method</div>
        <p>
          We solve the <span className="is-hit">Poisson–Nernst–Planck equations on a graded</span>{" "}
          mesh with adaptive time steps.
        </p>
        <div className="ld-skel" />
        <div className="ld-skel short" />
      </div>
    </div>
  );
}

/** Two rows of venue templates sliding past. */
function Marquee() {
  const half = Math.ceil(VENUES.length / 2);
  const rows = [VENUES.slice(0, half), VENUES.slice(half)];
  return (
    <div className="ld-marquee">
      {rows.map((row, r) => (
        <div key={row[0]} className={`ld-track ${r ? "reverse" : ""}`}>
          {[0, 1].flatMap((copy) =>
            row.map((venue) => (
              <span key={`${copy}:${venue}`} className="ld-venue" aria-hidden={copy === 1}>
                <span className="ld-venue-page">
                  <i />
                  <i />
                  <i />
                </span>
                {venue}
              </span>
            )),
          )}
        </div>
      ))}
    </div>
  );
}

/** A laptop and the server, keeping in step. */
function DesktopVisual() {
  return (
    <div className="ld-visual ld-desk" aria-hidden="true">
      <div className="ld-device">
        <DesktopIcon />
        <span>~/papers/electrolyte</span>
        <div className="ld-files">
          <i>main.tex</i>
          <i>refs.bib</i>
          <i>figures/</i>
        </div>
      </div>
      <div className="ld-pipe">
        <ArrowsClockwiseIcon />
        <span className="ld-packet" />
        <span className="ld-packet back" />
      </div>
      <div className="ld-device">
        <CloudArrowUpIcon />
        <span>lab server</span>
        <div className="ld-files">
          <i>main.tex</i>
          <i>refs.bib</i>
          <i>figures/</i>
        </div>
      </div>
    </div>
  );
}

function PrivateVisual() {
  return (
    <div className="ld-visual ld-private" aria-hidden="true">
      <div className="ld-orbit">
        <ShieldCheckIcon weight="fill" />
        <span className="ld-sat s1">
          <LockKeyIcon />
        </span>
        <span className="ld-sat s2">
          <DatabaseIcon />
        </span>
        <span className="ld-sat s3">
          <UsersThreeIcon />
        </span>
      </div>
    </div>
  );
}

function Feature({
  id,
  kicker,
  title,
  lead,
  points,
  visual,
  flip,
}: {
  id: string;
  kicker: string;
  title: string;
  lead: string;
  points?: string[];
  visual: ReactNode;
  flip?: boolean;
}) {
  return (
    <section id={id} className={`ld-feature ${flip ? "flip" : ""}`}>
      <div className="ld-feature-text" data-reveal>
        <span className="ld-kicker">{kicker}</span>
        <h2>{title}</h2>
        <p className="ld-lead">{lead}</p>
        {points && (
          <ul>
            {points.map((p) => (
              <li key={p}>
                <CheckIcon weight="bold" />
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ld-feature-visual ld-spot" data-reveal>
        {visual}
      </div>
    </section>
  );
}

export function Landing({
  signedIn,
  onLogin,
  onStart,
}: {
  signedIn: boolean;
  /** Signing in (or, when signed in, going to the projects). */
  onLogin: () => void;
  /** Signing up (or, when signed in, going to the projects). */
  onStart: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useReveal(root);
  // The hero's window leans back at first and straightens as the page scrolls.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = window.scrollY;
        setScrolled(y > 12);
        root.current?.style.setProperty("--lean", String(Math.max(0, 1 - y / 420)));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  useEffect(() => {
    const before = document.title;
    document.title = "Y-Writer";
    return () => {
      document.title = before;
    };
  }, []);
  // Cards light up where the pointer is.
  const spotlight = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = (event.target as HTMLElement).closest?.<HTMLElement>(".ld-spot");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    card.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };
  const go = (id: string) => () =>
    document.getElementById(id)?.scrollIntoView({ behavior: still() ? "auto" : "smooth" });
  const primary = signedIn ? t("land.open") : t("land.start");
  const faq = [1, 2, 3, 4, 5] as const;
  return (
    <div ref={root} className="landing" onPointerMove={spotlight}>
      <header className={`ld-nav ${scrolled ? "is-scrolled" : ""}`}>
        <button type="button" className="ld-brand" onClick={go("top")}>
          <img src="/logo-dark.svg" alt="Y-Writer" />
        </button>
        <nav>
          <button type="button" onClick={go("collab")}>
            {t("land.nav.features")}
          </button>
          <button type="button" onClick={go("ai")}>
            {t("land.nav.ai")}
          </button>
          <button type="button" onClick={go("templates")}>
            {t("land.nav.templates")}
          </button>
          <button type="button" onClick={go("desktop")}>
            {t("land.nav.desktop")}
          </button>
          <button type="button" onClick={go("faq")}>
            {t("land.nav.faq")}
          </button>
        </nav>
        <div className="ld-nav-end">
          <button
            type="button"
            className="ld-lang"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          >
            {locale === "zh" ? "EN" : "中文"}
          </button>
          {!signedIn && (
            <button type="button" className="ld-ghost" onClick={onLogin}>
              {t("land.login")}
            </button>
          )}
          <button type="button" className="ld-cta small" onClick={onStart}>
            {primary}
          </button>
        </div>
      </header>

      <section id="top" className="ld-hero">
        <div className="ld-grid" aria-hidden="true" />
        <div className="ld-aurora" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="ld-glyphs" aria-hidden="true">
          {["∑", "∫", "α", "∂", "λ", "∇", "π", "β", "Ω", "μ"].map((g, i) => (
            <span
              key={g}
              style={{
                left: `${((i * 37) % 88) + 5}%`,
                top: `${((i * 53) % 70) + 8}%`,
                fontSize: `${22 + ((i * 7) % 26)}px`,
                animationDelay: `${-i * 1.9}s`,
              }}
            >
              {g}
            </span>
          ))}
        </div>
        <div className="ld-hero-text">
          <button type="button" className="ld-badge" onClick={go("notes")}>
            <SparkleIcon weight="fill" />
            {t("land.badge")}
            <ArrowRightIcon />
          </button>
          <h1>
            <span>{t("land.title1")}</span>
            <span className="ld-gradient">{t("land.title2")}</span>
          </h1>
          <p className="ld-hero-lead">{t("land.lead")}</p>
          <div className="ld-actions">
            <button type="button" className="ld-cta" onClick={onStart}>
              {primary}
              <ArrowRightIcon weight="bold" />
            </button>
            {!signedIn && (
              <button type="button" className="ld-glass" onClick={onLogin}>
                {t("land.login")}
              </button>
            )}
            <a className="ld-link" href="/?desktop">
              <DesktopIcon />
              {t("land.download")}
            </a>
          </div>
          <p className="ld-trust">{t("land.trust")}</p>
        </div>
        <div className="ld-stage">
          <div className="ld-stage-glow" aria-hidden="true" />
          <div className="ld-lean">
            <HeroDemo />
          </div>
        </div>
      </section>

      <section className="ld-stats" data-reveal>
        <div>
          <strong>
            <Count to={23} />
          </strong>
          <span>{t("land.stat.templates")}</span>
        </div>
        <div>
          <strong>
            <Count to={3} />
          </strong>
          <span>{t("land.stat.ai")}</span>
        </div>
        <div>
          <strong>
            <Count to={4} />
          </strong>
          <span>{t("land.stat.roles")}</span>
        </div>
        <div>
          <strong>
            <Count to={24} suffix="h" />
          </strong>
          <span>{t("land.stat.backup")}</span>
        </div>
      </section>

      <Feature
        id="collab"
        kicker={t("land.collab.kicker")}
        title={t("land.collab.title")}
        lead={t("land.collab.lead")}
        points={[t("land.collab.p1"), t("land.collab.p2"), t("land.collab.p3")]}
        visual={<CollabVisual />}
      />
      <Feature
        id="notes"
        flip
        kicker={t("land.notes.kicker")}
        title={t("land.notes.title")}
        lead={t("land.notes.lead")}
        points={[t("land.notes.p1"), t("land.notes.p2"), t("land.notes.p3")]}
        visual={<NotesVisual />}
      />
      <Feature
        id="ai"
        kicker={t("land.ai.kicker")}
        title={t("land.ai.title")}
        lead={t("land.ai.lead")}
        points={[t("land.ai.p1"), t("land.ai.p2"), t("land.ai.p3")]}
        visual={<AiVisual />}
      />
      <Feature
        id="pdf"
        flip
        kicker={t("land.pdf.kicker")}
        title={t("land.pdf.title")}
        lead={t("land.pdf.lead")}
        points={[t("land.pdf.p1"), t("land.pdf.p2"), t("land.pdf.p3")]}
        visual={<SyncVisual />}
      />

      <section id="templates" className="ld-templates">
        <div className="ld-center" data-reveal>
          <span className="ld-kicker">{t("land.templates.kicker")}</span>
          <h2>{t("land.templates.title")}</h2>
          <p className="ld-lead">{t("land.templates.lead")}</p>
        </div>
        <Marquee />
      </section>

      <div className="ld-pair">
        <Feature
          id="desktop"
          kicker={t("land.desktop.kicker")}
          title={t("land.desktop.title")}
          lead={t("land.desktop.lead")}
          visual={<DesktopVisual />}
        />
        <Feature
          id="private"
          kicker={t("land.private.kicker")}
          title={t("land.private.title")}
          lead={t("land.private.lead")}
          visual={<PrivateVisual />}
        />
      </div>

      <section className="ld-steps">
        <h2 data-reveal>{t("land.steps.title")}</h2>
        <ol>
          {([1, 2, 3] as const).map((n) => (
            <li key={n} className="ld-spot" data-reveal style={{ transitionDelay: `${n * 90}ms` }}>
              <span className="ld-step-n">{n}</span>
              <strong>{t(`land.steps.${n}`)}</strong>
              <p>{t(`land.steps.${n}d`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="faq" className="ld-faq">
        <h2 data-reveal>{t("land.faq.title")}</h2>
        <div data-reveal>
          {faq.map((n) => (
            <details key={n}>
              <summary>
                {t(`land.faq.q${n}`)}
                <CaretDownIcon />
              </summary>
              <p>{t(`land.faq.a${n}`)}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="ld-final" data-reveal>
        <h2>{t("land.cta.title")}</h2>
        <p>{t("land.cta.lead")}</p>
        <div className="ld-actions">
          <button type="button" className="ld-cta" onClick={onStart}>
            {primary}
            <ArrowRightIcon weight="bold" />
          </button>
          <a className="ld-glass" href="/?desktop">
            <DesktopIcon />
            {t("land.download")}
          </a>
        </div>
      </section>

      <footer className="ld-footer">
        <img src="/logo-dark.svg" alt="Y-Writer" />
        <span>{t("land.footer")}</span>
        <span className="ld-muted">{t("land.footer.storage")}</span>
      </footer>
    </div>
  );
}
