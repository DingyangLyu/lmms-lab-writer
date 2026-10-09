"use client";
/** The desktop's AI side panel: the shared conversation tabs with its three local backends. */
import "@/lib/agent-platform";
import {
  HarnessButtons,
  type HarnessId,
  HarnessWorkspace as SharedHarnessWorkspace,
} from "@lmms-lab/workbench/agents";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { Props as OpenCodeProps } from "@/components/opencode/types";
import { desktopClaudeBackend } from "@/lib/claude/desktop-backend";
import { desktopCodexBackend } from "@/lib/codex/desktop-backend";
import { desktopHistory } from "@/lib/harness/history";

const PANELS = {
  opencode: dynamic(
    () => import("@/components/opencode/opencode-panel").then((m) => m.OpenCodePanel),
    { ssr: false },
  ),
  codex: dynamic(() => import("@lmms-lab/workbench/agents").then((m) => m.CodexPanel), {
    ssr: false,
  }),
  claude: dynamic(() => import("@lmms-lab/workbench/agents").then((m) => m.ClaudePanel), {
    ssr: false,
  }),
};

export { HarnessButtons };
export function HarnessWorkspace({
  opencode,
  ...props
}: Omit<ComponentProps<typeof SharedHarnessWorkspace>, "panels" | "panelProps" | "history"> & {
  opencode: Pick<
    OpenCodeProps,
    "baseUrl" | "autoConnect" | "daemonStatus" | "onRestartOpenCode" | "onMaxReconnectFailed"
  >;
}) {
  return (
    <SharedHarnessWorkspace
      {...props}
      panels={PANELS}
      panelProps={{
        opencode,
        codex: { backend: desktopCodexBackend },
        claude: { backend: desktopClaudeBackend },
      }}
      history={(backend: HarnessId) =>
        desktopHistory(backend, {
          project: props.shared.directory ?? "",
          baseUrl: opencode.baseUrl || "http://localhost:4096",
          openCodeReady: opencode.daemonStatus === "running",
        })
      }
    />
  );
}
