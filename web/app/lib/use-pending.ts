import { useCallback, useRef, useState } from "react";

/**
 * Runs one async action at a time. A second call while the first is pending is dropped, so repeated
 * Enter or Ctrl+Enter presses can't create duplicate records. The action should throw on failure; the
 * message is kept in `error` so the form can show it next to the controls the person just used.
 */
export function usePending() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const guard = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setPending(true);
    setError("");
    try {
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      running.current = false;
      setPending(false);
    }
  }, []);
  return { pending, error, guard, clearError: () => setError("") };
}
