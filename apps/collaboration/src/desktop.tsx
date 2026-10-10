/**
 * The desktop app's installers, as the server offers them: the ones for this computer first,
 * then every platform, with what to do when the system warns about an unsigned app.
 */
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { DesktopDownloads, DesktopInstaller } from "../shared/api";
import { api, errorText } from "./api";
import { type MessageKey, useI18n } from "./i18n";

type Platform = DesktopInstaller["platform"];
const PLATFORMS: Array<[Platform, string]> = [
  ["macos", "macOS"],
  ["windows", "Windows"],
  ["linux", "Linux"],
];
/** Best first: the .pkg lifts the quarantine itself; the setup .exe needs no administrator. */
const ORDER: DesktopInstaller["kind"][] = ["pkg", "dmg", "exe", "msi", "appimage", "deb", "rpm"];

/** The system this page runs on; phones and tablets get the full list. */
function currentPlatform(): Platform | null {
  const agent = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = `${agent.userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`;
  if (/android|iphone|ipad/i.test(name)) return null;
  if (/mac/i.test(name)) return "macos";
  if (/win/i.test(name)) return "windows";
  if (/linux|x11/i.test(name)) return "linux";
  return null;
}

export function DesktopPage() {
  const { t } = useI18n();
  const [downloads, setDownloads] = useState<DesktopDownloads | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void api<DesktopDownloads>("/downloads")
      .then(setDownloads)
      .catch((e) => setError(errorText(e)));
  }, []);
  const mine = currentPlatform();
  const sorted = [...(downloads?.installers ?? [])].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.arch === "arm64" ? -1 : 1),
  );
  // For this computer: the best kind for each processor it comes in.
  const recommended: DesktopInstaller[] = [];
  for (const i of sorted)
    if (i.platform === mine && !recommended.some((r) => r.arch === i.arch)) recommended.push(i);
  const arch = (i: DesktopInstaller) =>
    i.arch ? t(`desktop.${i.arch}${i.platform === "macos" ? "Mac" : ""}` as MessageKey) : "";
  const href = (i: DesktopInstaller) => `/api/downloads/${encodeURIComponent(i.name)}`;
  const size = (i: DesktopInstaller) =>
    t("desktop.size", { size: (i.bytes / 1_048_576).toFixed(i.bytes < 10_485_760 ? 1 : 0) });
  return (
    <main className="page">
      <div className="page-head">
        <h1>{t("desktop.title")}</h1>
        <p className="muted">
          {t("desktop.lead")}
          {downloads?.version && <> · {t("desktop.version", { version: downloads.version })}</>}
        </p>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {downloads && !downloads.installers.length && (
        <section className="panel">
          <p className="muted">{t("desktop.none")}</p>
        </section>
      )}
      {recommended.length > 0 && (
        <section className="panel">
          <h2>{t("desktop.forYou")}</h2>
          <div className="installer-picks">
            {recommended.map((i) => (
              <a key={i.name} className="button-like primary" href={href(i)}>
                <DownloadSimpleIcon aria-hidden="true" />
                {[PLATFORMS.find(([p]) => p === i.platform)?.[1], arch(i)]
                  .filter(Boolean)
                  .join(" · ")}
                <span className="installer-size">{size(i)}</span>
              </a>
            ))}
          </div>
        </section>
      )}
      {sorted.length > 0 && (
        <section className="panel">
          <h2>{t("desktop.all")}</h2>
          {PLATFORMS.map(([platform, label]) => {
            const items = sorted.filter((i) => i.platform === platform);
            if (!items.length) return null;
            return (
              <div key={platform}>
                <h3>{label}</h3>
                <ul className="installers">
                  {items.map((i) => (
                    <li key={i.name}>
                      <span className="installer-kind">
                        {t(`desktop.kind.${i.kind}` as MessageKey)}
                        {i.arch && <span className="muted"> · {arch(i)}</span>}
                      </span>
                      <span className="muted installer-size">{size(i)}</span>
                      <a href={href(i)} title={i.name}>
                        {t("desktop.download")}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
      <section className="panel">
        <h2>{t("desktop.installTitle")}</h2>
        <h3>macOS</h3>
        <p>{t("desktop.installMac")}</p>
        <pre className="installer-command">
          xattr -dr com.apple.quarantine /Applications/Y-Writer.app
        </pre>
        <h3>Windows</h3>
        <p>{t("desktop.installWindows")}</p>
        <h3>Linux</h3>
        <p>{t("desktop.installLinux")}</p>
        <h3>{t("desktop.connectTitle")}</h3>
        <p>{t("desktop.connect", { origin: location.origin })}</p>
      </section>
    </main>
  );
}
