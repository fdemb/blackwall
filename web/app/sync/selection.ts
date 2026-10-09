import type { Entity } from "./records";
import type { SyncStore } from "./store";

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && Object.is(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}

export function createSelection<T>(
  store: SyncStore,
  select: (store: SyncStore) => T,
  entities: readonly Entity[],
  previous?: { value: T },
) {
  let cached: { versions: number[]; value: T } | undefined;
  let last = previous;
  return () => {
    const versions = entities.map((entity) => store.version(entity));
    if (cached && shallowEqual(cached.versions, versions)) return cached.value;
    const value = select(store);
    cached = { versions, value: last && shallowEqual(last.value, value) ? last.value : value };
    last = cached;
    return cached.value;
  };
}
