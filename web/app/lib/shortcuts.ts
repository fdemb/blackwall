import { useCallback, useSyncExternalStore } from "react";
import { safeGet, safeSet } from "./storage";

const KEY = "bw-shortcuts:v1";
const listeners = new Set<() => void>();
let storageHooked = false;

function ensureStorageHook() {
  if (storageHooked || typeof window === "undefined") return;
  storageHooked = true;
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === KEY) listeners.forEach((l) => l());
  });
}

const read = () => (typeof window === "undefined" ? true : safeGet("local", KEY) !== "off");

/** Single-key shortcuts (C, /, G then a letter) can clash with speech input, so they can be turned off. */
export function useShortcutsEnabled() {
  const subscribe = useCallback((cb: () => void) => {
    ensureStorageHook();
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  const enabled = useSyncExternalStore(subscribe, read, () => true);
  const set = useCallback((on: boolean) => {
    safeSet("local", KEY, on ? "on" : "off");
    listeners.forEach((l) => l());
  }, []);
  return [enabled, set] as const;
}
