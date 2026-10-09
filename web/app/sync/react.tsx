import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type DependencyList,
} from "react";
import type { SyncEngine } from "./engine";
import type { Scope } from "./persistence/types";
import type { Entity } from "./records";
import type { SyncStore } from "./store";
import { createSelection } from "./selection";

export const EngineContext = createContext<SyncEngine | null>(null);

export function EngineProvider({ engine, children }: { engine: SyncEngine; children: ReactNode }) {
  return <EngineContext value={engine}>{children}</EngineContext>;
}

export function useEngine() {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("EngineProvider missing");
  return engine;
}

export function useSyncStatus() {
  const { status } = useEngine();
  return useSyncExternalStore(status.subscribe, status.get, status.get);
}

// The caller's dependency tuple owns invalidation; inline selectors keep their cache.
/* oxlint-disable react-hooks/exhaustive-deps, react/use-memo */
export function useView<T>(
  select: (store: SyncStore) => T,
  entities: readonly Entity[],
  deps: DependencyList,
): T {
  const { store } = useEngine();
  const previous = useRef<{ value: T } | undefined>(undefined);
  const tables = JSON.stringify(entities);
  const snapshot = useMemo(
    () => createSelection(store, select, entities, previous.current),
    [store, tables, ...deps],
  );
  const subscribe = useMemo(
    () => (notify: () => void) =>
      store.subscribe((event) => {
        if (entities.some((entity) => event.entities.has(entity))) notify();
      }),
    [store, tables],
  );
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    previous.current = { value };
  }, [value]);
  return value;
}
/* oxlint-enable react-hooks/exhaustive-deps, react/use-memo */

export function useRecord<E extends Entity>(entity: E, id: string) {
  const { store } = useEngine();
  const subscribe = useMemo(
    () => (notify: () => void) =>
      store.subscribe((event) => {
        if (event.keys.get(entity)?.has(id)) notify();
      }),
    [store, entity, id],
  );
  const snapshot = () => store.get(entity, id);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useScope(scope: Scope) {
  const engine = useEngine();
  const entity = scope.entity;
  const id = scope.entity === "comments" ? scope.issueId : scope.entityId;
  useEffect(
    () =>
      engine.useScope(entity === "comments" ? { entity, issueId: id } : { entity, entityId: id }),
    [engine, entity, id],
  );
}
