import { MemoryReplicaStorage } from "../persistence/memory";
import { StorageFullError } from "../persistence/shared";
import type { ReplicaStorage } from "../persistence/types";

/** A store whose writes fail like a full disk while `full` is set. `allow` exempts method names. */
export function limited(inner: ReplicaStorage = new MemoryReplicaStorage()) {
  const writes = new Set([
    "writeBootstrap",
    "applyPull",
    "writeScope",
    "appendMutation",
    "confirm",
  ]);
  const disk = {
    full: false,
    allow: new Set<string>(),
    attempts: new Map<string, number>(),
    storage: {
      open: async (input) => {
        const replica = await inner.open(input);
        return new Proxy(replica, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key);
            if (typeof value !== "function") return value;
            if (typeof key !== "string" || !writes.has(key))
              return (...args: unknown[]) => value.apply(target, args);
            return (...args: unknown[]) => {
              disk.attempts.set(key, (disk.attempts.get(key) ?? 0) + 1);
              if (disk.full && !disk.allow.has(key)) return Promise.reject(new StorageFullError());
              return value.apply(target, args);
            };
          },
        });
      },
      list: () => inner.list(),
      delete: (identity) => inner.delete(identity),
    } satisfies ReplicaStorage,
  };
  return disk;
}
