"use client";
/**
 * Where the AI of a folder linked to a server project runs: on this computer (its own CLIs,
 * editing the folder) or on the server's shared runner, as on the web (shared conversations,
 * edits into the server project, which the folder sync brings back). Remembered per folder.
 */
import { type AgentLink, type AgentStatus, RelayAgentsPanel } from "@lmms-lab/workbench/agents";
import { type ComponentProps, type ReactNode, useEffect, useMemo, useState } from "react";
import { listAccounts, type SyncLink } from "@/lib/collab/accounts";
import { desktopAgentLink } from "@/lib/collab/agent-link";
import { useI18n } from "@/lib/i18n";

type Location = "local" | "server";
const KEY = "writer-agent-location:";
const saved = (project: string): Location => {
  try {
    return localStorage.getItem(KEY + project) === "server" ? "server" : "local";
  } catch {
    return "local";
  }
};

export function AgentLocation({
  projectPath,
  link,
  local,
  server,
}: {
  projectPath: string | null;
  link: SyncLink | null;
  /** The column with this computer's agents. */
  local: ReactNode;
  /** The server's column, given its link (the panel's other props come from the page). */
  server: Omit<ComponentProps<typeof RelayAgentsPanel>, "link" | "project" | "workspaceKey">;
}) {
  const { t } = useI18n();
  const [location, setLocation] = useState<Location>("local");
  useEffect(() => setLocation(projectPath ? saved(projectPath) : "local"), [projectPath]);
  const choose = (next: Location) => {
    setLocation(next);
    try {
      if (projectPath) localStorage.setItem(KEY + projectPath, next);
    } catch {}
  };
  // The member this computer is signed in as on that server, for "your turn is running".
  const [me, setMe] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setMe(undefined);
    if (!link) return;
    let current = true;
    void listAccounts()
      .then((accounts) => {
        if (current) setMe(accounts.find((a) => a.server === link.server)?.user.id ?? null);
      })
      .catch(() => current && setMe(null));
    return () => {
      current = false;
    };
  }, [link]);
  const onServer = !!link && location === "server";
  const agents: AgentLink | null = useMemo(
    () => (onServer && link && me ? desktopAgentLink(link.server, link.project, me) : null),
    [onServer, link, me],
  );
  useEffect(() => () => agents?.close(), [agents]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    return agents?.onStatus(setStatus);
  }, [agents]);
  if (!link) return <>{local}</>;
  const runner = status?.name || t("agentLocation.runner");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
        <span className="text-muted-foreground">{t("agentLocation.label")}</span>
        <div className="flex border border-border">
          {(["local", "server"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={location === id}
              title={
                id === "local"
                  ? t("agentLocation.localTitle")
                  : t("agentLocation.serverTitle", { runner })
              }
              className={`px-2 py-0.5 ${location === id ? "bg-foreground text-background" : "hover:bg-accent"}`}
              onClick={() => choose(id)}
            >
              {t(`agentLocation.${id}`)}
            </button>
          ))}
        </div>
        {onServer && (
          <span className="min-w-0 truncate text-muted-foreground">
            {status && !status.online ? t("agentLocation.offline") : status?.name}
          </span>
        )}
      </div>
      {/* This computer's panels stay mounted, so a running turn keeps its view. */}
      <div className={onServer ? "hidden" : "min-h-0 flex-1"}>{local}</div>
      <div className={onServer ? "min-h-0 flex-1" : "hidden"}>
        {!onServer ? null : me === null ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("agentLocation.signIn", { server: link.server })}
          </p>
        ) : agents ? (
          <RelayAgentsPanel
            link={agents}
            project={link.project}
            workspaceKey={`${link.server}#${link.project}`}
            {...server}
          />
        ) : null}
      </div>
    </div>
  );
}
