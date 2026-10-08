import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { getReadableErrorMessage } from "@/lib/errors";
import { i18n } from "@/lib/i18n";

export type OpenCodeStatus = {
  running: boolean;
  port: number;
  installed: boolean;
  managed?: boolean;
  webSearchEnabled?: boolean;
};
export type OpenCodeDaemonStatus = "stopped" | "starting" | "running" | "unavailable";

/**
 * The app-managed `opencode serve` process: one server for every open project, started on
 * demand (when an OpenCode tab exists or another feature needs it) and restartable from the UI.
 */
export function useOpenCodeDaemon(projectPath: string | null, autoStart: boolean) {
  const { toast } = useToast();
  const [status, setStatus] = useState<OpenCodeDaemonStatus>("stopped");
  const [port, setPort] = useState(4096);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const startedFor = useRef<string | null>(null);

  const check = useCallback(async () => {
    try {
      const current = await invoke<OpenCodeStatus>("opencode_status");
      if (!current.installed) setStatus("unavailable");
      else if (current.running && current.managed) {
        setStatus("running");
        setPort(current.port);
      } else setStatus("stopped");
      return current;
    } catch {
      setStatus("unavailable");
      return null;
    }
  }, []);

  const start = useCallback(
    async (directory: string) => {
      try {
        setStatus("starting");
        setError(null);
        const started = await invoke<OpenCodeStatus>("opencode_start", { directory, port: 4096 });
        setStatus("running");
        setPort(started.port);
        startedFor.current = directory;
        return started;
      } catch (cause) {
        const message = getReadableErrorMessage(cause, i18n.t("msg.failedToStartOpencode"));
        console.error(`Failed to start OpenCode: ${message}`);
        setStatus(message.includes("OpenCode not found") ? "unavailable" : "stopped");
        setError(message);
        toast(message, "error");
        return null;
      }
    },
    [toast],
  );

  /** A running app-managed server that serves `directory`; null when OpenCode is unavailable. */
  const ensure = useCallback(
    async (directory: string) => {
      const current = await check();
      if (!current?.installed) return null;
      if (current.running && current.managed && startedFor.current === directory) return current;
      return start(directory);
    },
    [check, start],
  );

  const restart = useCallback(async () => {
    if (!projectPath) {
      toast(i18n.t("msg.pleaseOpenAProjectFirst"), "error");
      return;
    }
    // OpenCode may have been installed since the last check.
    if (status === "unavailable") {
      const current = await check();
      if (!current?.installed) {
        toast(i18n.t("msg.opencodeIsStillNotInstalledPleaseInstall"), "error");
        return;
      }
      if (await start(projectPath)) toast(i18n.t("msg.opencodeStartedSuccessfully"), "success");
      return;
    }
    try {
      setStatus("starting");
      setError(null);
      const current = await invoke<OpenCodeStatus>("opencode_status");
      if (!current.installed) {
        setStatus("unavailable");
        setError(i18n.t("msg.opencodeIsNotInstalledPleaseInstallItFir"));
        return;
      }
      const restarted = await invoke<OpenCodeStatus>("opencode_restart", {
        directory: projectPath,
      });
      setStatus("running");
      setPort(restarted.port);
      startedFor.current = projectPath;
      toast(i18n.t("msg.opencodeStartedSuccessfully"), "success");
    } catch (cause) {
      const message = getReadableErrorMessage(cause, i18n.t("msg.failedToStartOpencode"));
      console.error(`Failed to start OpenCode: ${message}`);
      setStatus("stopped");
      setError(message);
    }
  }, [projectPath, status, toast, check, start]);

  const showDisconnected = useCallback(() => setDisconnected(true), []);
  const closeDisconnected = useCallback(() => setDisconnected(false), []);
  const restartFromDisconnected = useCallback(() => {
    setDisconnected(false);
    void restart();
  }, [restart]);
  const clearError = useCallback(() => setError(null), []);
  const killPortAndRestart = useCallback(
    async (busyPort: number) => {
      await invoke("kill_port_process", { port: busyPort });
      setError(null);
      await restart();
    },
    [restart],
  );

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (!projectPath) startedFor.current = null;
  }, [projectPath]);

  useEffect(() => {
    if (!autoStart || !projectPath) return;
    let cancelled = false;
    void check().then((current) => {
      if (cancelled || !current?.installed) return;
      if (current.running && current.managed && startedFor.current === projectPath) return;
      void start(projectPath);
    });
    return () => {
      cancelled = true;
    };
  }, [autoStart, projectPath, check, start]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ type: string; message: string }>("opencode-log", (event) => {
        if (event.payload.type === "stderr") console.error("[OpenCode]", event.payload.message);
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return {
    status,
    port,
    error,
    disconnected,
    ensure,
    restart,
    showDisconnected,
    closeDisconnected,
    restartFromDisconnected,
    clearError,
    killPortAndRestart,
  };
}
