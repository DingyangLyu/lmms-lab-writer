/**
 * The dark band at the top of the pages around the editor, in the homepage's colours: a title,
 * a line under it, and the page's main controls on the right. The page's cards rise into it.
 */
import type { ReactNode } from "react";

export function PageHero({
  eyebrow,
  title,
  lead,
  wide = false,
  children,
}: {
  /** A short line above the title, such as a greeting. */
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  /** As wide as the window (the project list, templates) rather than the reading column. */
  wide?: boolean;
  /** Search, buttons and the like. */
  children?: ReactNode;
}) {
  return (
    <header className={`page-hero ${wide ? "wide" : ""}`}>
      <div className="page-hero-inner">
        <div className="page-hero-text">
          {eyebrow && <p className="page-hero-eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {lead && <p className="page-hero-lead">{lead}</p>}
        </div>
        {children && <div className="page-hero-end">{children}</div>}
      </div>
    </header>
  );
}
