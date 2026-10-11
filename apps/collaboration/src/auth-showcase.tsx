/**
 * The moving picture beside the sign-in form: LaTeX typed into an editor while the PDF beside
 * it fills in, a colleague's cursor, a sticky note naming someone, and an AI conversation
 * taking the note on, then round again. Without motion (prefers-reduced-motion) it shows the
 * finished scene.
 */
import { useEffect, useState } from "react";
import { useI18n } from "./i18n";
import { typedBy, walk } from "./scene";

const SOURCE = [
  "\\section{Results}",
  "We measure the activation",
  "barrier $E_a$ of the",
  "electrolyte~\\cite{wang2024}.",
  "\\begin{equation}",
  "  k = A\\,e^{-E_a/RT}",
  "\\end{equation}",
];
const TOTAL = SOURCE.join("\n").length;
/** Milliseconds per typed character, and the scene's later beats (in characters' time). */
const STEP = 42,
  NOTE = TOTAL + 18,
  AI = TOTAL + 50,
  END = TOTAL + 120;
/** Wang comes to line 3 once it is written: columns to stop at, and steps waited there. */
const PEER_LINE = 2,
  PEER_STOPS = [
    [8, 20],
    [20, 30],
    [14, 0],
  ] as const;

/** Characters typed so far: the scene's clock. */
function useClock() {
  const [still] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const [at, setAt] = useState(still ? AI + 10 : 0);
  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setAt((n) => (n >= END ? 0 : n + 1)), STEP);
    return () => clearInterval(timer);
  }, [still]);
  return at;
}

/** A source line with LaTeX's colours: commands, braces' contents, math. */
function Highlighted({ text }: { text: string }) {
  const parts: Array<{ text: string; kind: string; at: number }> = [];
  const pattern = /(\\[A-Za-z]+|\\,|\{[^}]*\}?|\$[^$]*\$?|~)/g;
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > last) parts.push({ text: text.slice(last, found.index), kind: "", at: last });
    const token = found[0];
    parts.push({
      at: found.index,
      text: token,
      kind: token.startsWith("\\")
        ? "cmd"
        : token.startsWith("$")
          ? "math"
          : token === "~"
            ? "cmd"
            : "arg",
    });
    last = found.index + token.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), kind: "", at: last });
  return (
    <>
      {parts.map((p) => (
        <span key={p.at} className={p.kind ? `hero-${p.kind}` : undefined}>
          {p.text}
        </span>
      ))}
    </>
  );
}

export function AuthShowcase() {
  const { t } = useI18n();
  const at = useClock();
  // The lines as typed so far, and which have been finished.
  let left = at;
  const lines = SOURCE.map((line) => {
    const shown = line.slice(0, Math.max(0, left));
    left -= line.length + 1;
    return shown;
  });
  const done = (line: number) => (lines[line]?.length ?? 0) >= (SOURCE[line]?.length ?? 0);
  const typing = lines.findIndex((line, i) => line.length < (SOURCE[i]?.length ?? 0));
  const fading = at > END - 12;
  return (
    <div className={`hero-stage ${fading ? "hero-fading" : ""}`} aria-hidden="true">
      <div className="hero-window">
        <div className="hero-bar">
          <span className="hero-dot" />
          <span className="hero-dot" />
          <span className="hero-dot" />
          <span className="hero-file">main.tex</span>
          <span className="hero-people">
            <span className="hero-avatar" style={{ background: "#7c3aed" }}>
              A
            </span>
            <span className="hero-avatar" style={{ background: "#0ea5e9" }}>
              W
            </span>
          </span>
        </div>
        <div className="hero-panes">
          <div className="hero-editor">
            {SOURCE.map((line, i) => (
              <div key={line} className="hero-line">
                <span className="hero-number">{i + 1}</span>
                <span className="hero-code">
                  <Highlighted text={lines[i] ?? ""} />
                  {i === typing && <span className="hero-caret" />}
                  {i === PEER_LINE && done(i) && (
                    <span
                      className="hero-peer"
                      style={{ left: `${walk(PEER_STOPS, at - typedBy(SOURCE, i))}ch` }}
                    >
                      <span className="hero-peer-flag">Wang</span>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div className="hero-pdf">
            <div className="hero-page">
              {done(0) && <div className="hero-h hero-in">2&nbsp;&nbsp; Results</div>}
              {done(1) && (
                <p className="hero-p hero-in">
                  We measure the{" "}
                  <mark className={at > NOTE ? "hero-mark on" : "hero-mark"}>
                    activation barrier
                  </mark>
                  {done(2) && (
                    <>
                      {" "}
                      <i>E</i>
                      <sub>a</sub> of the
                    </>
                  )}
                  {done(3) && <> electrolyte [1].</>}
                </p>
              )}
              {done(6) && (
                <div className="hero-eq hero-in">
                  <span>
                    <i>k</i> = <i>A</i> e
                    <sup>
                      −<i>E</i>a/<i>RT</i>
                    </sup>
                  </span>
                  <span className="hero-eq-no">(1)</span>
                </div>
              )}
              {!done(0) && <div className="hero-skeleton" />}
            </div>
            {at > NOTE && (
              <div className="hero-note">
                <div className="hero-note-head">
                  <span className="hero-avatar" style={{ background: "#7c3aed" }}>
                    A
                  </span>
                  <strong>Ann</strong>
                  <span>{t("hero.justNow")}</span>
                </div>
                <div className="hero-note-quote">activation barrier</div>
                <div>
                  <span className="hero-at">@Wang</span> {t("hero.note")}
                </div>
              </div>
            )}
            {at > AI && (
              <div className="hero-ai">
                <span className="hero-ai-icon">✦</span>
                {t("hero.ai")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
