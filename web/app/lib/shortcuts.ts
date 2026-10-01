import { useCallback, useSyncExternalStore } from "react";

const KEY = "bw-shortcuts";
const listeners = new Set<() => void>();

const read = () => (typeof localStorage === "undefined" ? true : localStorage.getItem(KEY) !== "off");

/** Single-key shortcuts (C, /, G then a letter) can clash with speech input, so they can be turned off. */
export function useShortcutsEnabled() {
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb);
    addEventListener("storage", cb);
    return () => {
      listeners.delete(cb);
      removeEventListener("storage", cb);
    };
  }, []);
  const enabled = useSyncExternalStore(subscribe, read, () => true);
  const set = useCallback((on: boolean) => {
    localStorage.setItem(KEY, on ? "on" : "off");
    listeners.forEach((l) => l());
  }, []);
  return [enabled, set] as const;
}
