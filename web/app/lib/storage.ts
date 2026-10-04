/** Versioned storage access that never throws (private mode, SSR, denied access). */

export function safeGet(storage: "local" | "session", key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    const store = storage === "local" ? window.localStorage : window.sessionStorage;
    return store.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(storage: "local" | "session", key: string, value: string) {
  try {
    if (typeof window === "undefined") return;
    const store = storage === "local" ? window.localStorage : window.sessionStorage;
    store.setItem(key, value);
  } catch {
    // Storage full or blocked; the in-memory state still works for this tab.
  }
}

export function safeRemove(storage: "local" | "session", key: string) {
  try {
    if (typeof window === "undefined") return;
    const store = storage === "local" ? window.localStorage : window.sessionStorage;
    store.removeItem(key);
  } catch {
    // Nothing to clean up.
  }
}
