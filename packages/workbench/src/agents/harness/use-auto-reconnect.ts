import { useCallback, useEffect, useRef } from "react";

/**
 * Shared runner only: when the connection to the server drops (a campus network can cut long
 * connections), connect again on its own instead of waiting for a click. `retry` reruns the
 * panel's start-up, which reloads the open conversation.
 */
export function useAutoReconnect(enabled: boolean, retry: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (delay = 3000) => {
      if (!enabled || timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        retryRef.current();
      }, delay);
    },
    [enabled],
  );
}
