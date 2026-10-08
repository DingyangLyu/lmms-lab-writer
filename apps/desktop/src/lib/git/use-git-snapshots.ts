"use client";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveManager } from "@/lib/editor/save-manager";
import { i18n } from "@/lib/i18n";
import { afterGitCheck, observeGit, type SnapshotClock } from "./snapshot-clock";

type Status = { isRepo: boolean; head: string | null; snapshot: string | null };
type Result = { created: boolean; hash: string };
export function useGitSnapshots(project: string, manager: SaveManager, paused: boolean) {
  const key = `writer-git-snapshots:${project}`;
  const [enabled, setEnabled] = useState(true);
  const [clock, setClock] = useState<SnapshotClock | null>(null);
  const clockRef = useRef<SnapshotClock | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const remember = useCallback(
    (value: SnapshotClock) => {
      clockRef.current = value;
      setClock(value);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* Git remains the durable store. */
      }
    },
    [key],
  );
  const save = useCallback(async () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await manager.flushAll();
      const result = await invoke<Result>("git_create_snapshot", { project });
      const status = await invoke<Status>("git_snapshot_status", { project });
      remember(afterGitCheck(status, Date.now()));
      setMessage(
        result.created
          ? i18n.t("msg.savedGitVersionHash", { hash: result.hash.slice(0, 7) })
          : i18n.t("msg.noNewChangesTheGitVersionIsUpToDate"),
      );
      return true;
    } catch (cause) {
      setError(i18n.t("msg.couldNotSaveAGitVersionError", { error: String(cause) }));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [project, manager, remember]);
  useEffect(() => {
    let cancelled = false;
    let checking = false;
    setEnabled(localStorage.getItem(`${key}:enabled`) !== "false");
    try {
      clockRef.current = JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      clockRef.current = null;
    }
    setClock(clockRef.current);
    const check = async () => {
      if (checking || busyRef.current) return;
      checking = true;
      try {
        const status = await invoke<Status>("git_snapshot_status", { project });
        if (cancelled) return;
        const current = observeGit(clockRef.current, status, Date.now());
        remember(current);
        if (
          localStorage.getItem(`${key}:enabled`) !== "false" &&
          Date.now() >= current.due &&
          !pausedRef.current
        )
          await save();
      } catch (cause) {
        if (!cancelled)
          setError(i18n.t("msg.theGitAutoSaveCheckFailedError", { error: String(cause) }));
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30000);
    const foreground = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [project, key, remember, save]);
  const toggle = () => {
    const next = !enabled;
    localStorage.setItem(`${key}:enabled`, String(next));
    setEnabled(next);
    if (next && clockRef.current) remember(afterGitCheck(clockRef.current, Date.now()));
  };
  return { enabled, toggle, clock, busy, message, error, save };
}
