"use client";
import { useEffect, useRef, useState } from "react";
import { IdleTranscript } from "./idle-transcript";
import { transcriptCache } from "./transcript-cache";
export const TRANSCRIPT_IDLE_MS = 60_000;
export function useIdleTranscript<T>({
  scope,
  active,
  protectedWork,
  value,
  release,
  restore,
}: {
  scope: string;
  active: boolean;
  protectedWork: boolean;
  value: T;
  release: () => void;
  restore: (snapshot: T) => void;
}) {
  const [sleeping, setSleeping] = useState(false);
  const [error, setError] = useState("");
  const current = useRef({ value, canSleep: !active && !protectedWork, release, restore });
  current.current = { value, canSleep: !active && !protectedWork, release, restore };
  const control = useRef<IdleTranscript<T> | null>(null);
  useEffect(() => {
    const cache = new IdleTranscript<T>(
      `${scope}:${crypto.randomUUID()}`,
      transcriptCache,
      () => current.current,
      () => current.current.release(),
      (snapshot) => current.current.restore(snapshot),
      setSleeping,
    );
    control.current = cache;
    setSleeping(false);
    setError("");
    return () => {
      control.current = null;
      cache.dispose();
    };
  }, [scope]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A scope change replaces the controller, so its idle timer must restart.
  useEffect(() => {
    const cache = control.current;
    if (!cache) return;
    if (active || protectedWork) {
      void cache.wake().catch((cause) => setError(String(cause)));
      return;
    }
    const timer = setTimeout(
      () =>
        void cache.sleep().catch(() => {
          /* Keep history resident if local storage is unavailable. */
        }),
      TRANSCRIPT_IDLE_MS,
    );
    return () => clearTimeout(timer);
  }, [active, protectedWork, scope]);
  return {
    sleeping,
    error,
    retry: () =>
      void control.current
        ?.wake()
        .then(() => setError(""))
        .catch((cause) => setError(String(cause))),
  };
}
