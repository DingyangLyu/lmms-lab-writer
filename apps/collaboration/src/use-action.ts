import { useCallback, useState } from "react";
import { errorText } from "./api";

/** Busy flag and error message for user-triggered requests; `run` never throws. */
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = useCallback((action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    void action()
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, []);
  return { busy, error, setError, run };
}
