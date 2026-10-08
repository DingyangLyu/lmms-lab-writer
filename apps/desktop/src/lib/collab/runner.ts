"use client";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { deviceName, type SyncLink } from "./accounts";
import { requestError } from "./transport";

export type RunnerHarness = "codex" | "claude" | "opencode";
export const RUNNER_HARNESSES: { id: RunnerHarness; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
];
export type RunnerActivity = {
  state: "off" | "idle" | "running" | "error";
  prompt?: string;
  message?: string;
  completed: number;
};
type Job = { id: string; prompt: string; harness: string };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This computer as a runner for a project's shared AI tasks, while the linked folder is open.
 * Tasks run on a disposable copy (Rust `runner_execute`) and return as review proposals.
 */
export function useSharedRunner(link: SyncLink | null) {
  const [harnesses, setHarnesses] = useState<RunnerHarness[] | null>(null);
  const [activity, setActivity] = useState<RunnerActivity>({ state: "off", completed: 0 });

  useEffect(() => {
    setHarnesses(null);
    if (!link) return;
    let current = true;
    invoke<{ capabilities: RunnerHarness[] } | null>("collab_runner_get", {
      server: link.server,
      project: link.project,
    })
      .then((runner) => {
        if (current) setHarnesses(runner?.capabilities ?? null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [link]);

  useEffect(() => {
    if (!link || !harnesses?.length) {
      setActivity((a) => ({ ...a, state: "off", prompt: undefined }));
      return;
    }
    let stopped = false;
    const call = async <T>(action: "lease" | "heartbeat" | "result", body: unknown) => {
      try {
        return await invoke<T>("collab_runner_call", {
          server: link.server,
          project: link.project,
          action,
          body,
        });
      } catch (error) {
        throw requestError(error);
      }
    };
    void (async () => {
      setActivity((a) => ({ ...a, state: "idle", message: undefined }));
      while (!stopped) {
        try {
          const { job } = await call<{ job: Job | null }>("lease", {});
          if (!job) {
            await pause(3000);
            continue;
          }
          const id = job.id;
          setActivity((a) => ({ ...a, state: "running", prompt: job.prompt }));
          // A cancelled task stops accepting heartbeats; stop the local process then.
          const beat = setInterval(() => {
            void call("heartbeat", { id }).catch(() => invoke("runner_cancel", { job: id }));
          }, 15000);
          try {
            const result = await invoke<{ files: unknown[]; result: string }>("runner_execute", {
              job,
            });
            await call("result", { id, ...result });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await call("result", {
              id,
              error: true,
              result: message.slice(-45000),
              files: [],
            }).catch(() => {});
          } finally {
            clearInterval(beat);
          }
          setActivity((a) => ({ state: "idle", completed: a.completed + 1 }));
        } catch (error) {
          const problem = requestError(error);
          setActivity((a) => ({ ...a, state: "error", message: problem.message }));
          // Removed on the web page, or no longer the owner: switch off.
          if (problem.status === 401) {
            setHarnesses(null);
            return;
          }
          await pause(10000);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [link, harnesses]);

  const enable = useCallback(
    async (chosen: RunnerHarness[]) => {
      if (!link || !chosen.length) return;
      try {
        await invoke("collab_runner_register", {
          server: link.server,
          project: link.project,
          name: await deviceName(),
          capabilities: chosen,
        });
      } catch (error) {
        throw requestError(error);
      }
      setHarnesses(chosen);
    },
    [link],
  );
  const disable = useCallback(async () => {
    if (!link) return;
    try {
      await invoke("collab_runner_unregister", { server: link.server, project: link.project });
    } catch (error) {
      throw requestError(error);
    }
    setHarnesses(null);
  }, [link]);
  return { harnesses, activity, enable, disable };
}
export type SharedRunner = ReturnType<typeof useSharedRunner>;
