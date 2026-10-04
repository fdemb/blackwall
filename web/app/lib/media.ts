import { useCallback, useSyncExternalStore } from "react";

const cache = new Map<string, MediaQueryList>();

function mql(query: string): MediaQueryList | null {
  if (typeof matchMedia === "undefined") return null;
  let list = cache.get(query);
  if (!list) {
    list = matchMedia(query);
    cache.set(query, list);
  }
  return list;
}

export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mql(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => mql(query)?.matches ?? false,
    () => false,
  );
}
