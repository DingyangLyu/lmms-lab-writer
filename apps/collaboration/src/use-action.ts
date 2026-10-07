import { useCallback, useState } from "react";

/** Busy flag and error message for user-triggered requests; `run` never throws. */
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = useCallback((action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void action()
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, []);
  return { busy, error, setError, run };
}
