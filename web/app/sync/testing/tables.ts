import type { Entity, RecordOf } from "../records";
import { ENTITIES, keyOf } from "../records";
import type { DeepReadonly, IndexName, Tx } from "../store";

export interface Pair {
  entity: Entity;
  id: string;
}

/** Workspace-local tables. A command writes to a fork, swapped in only on success. */
export class Tables implements Tx {
  private readonly rows = new Map<Entity, Map<string, object>>();
  readonly touched = new Map<string, Pair>();

  constructor(source?: Tables) {
    for (const entity of ENTITIES) {
      this.rows.set(entity, new Map(source?.rows.get(entity)));
    }
  }

  get<E extends Entity>(entity: E, key: string): DeepReadonly<RecordOf[E]> | undefined {
    // The entity-keyed boundary is written only by the generic put method.
    return this.rows.get(entity)?.get(key) as DeepReadonly<RecordOf[E]> | undefined;
  }

  put<E extends Entity>(entity: E, record: DeepReadonly<RecordOf[E]>): void {
    const copy = structuredClone(record);
    const id =
      entity === "alert_preferences" && "user_id" in copy
        ? copy.user_id
        : keyOf(entity, copy as RecordOf[E]);
    this.rows.get(entity)?.set(id, freeze(copy));
    this.touched.set(`${entity}:${id}`, { entity, id });
  }

  delete(entity: Entity, id: string): void {
    this.rows.get(entity)?.delete(id);
    this.touched.set(`${entity}:${id}`, { entity, id });
  }

  all<E extends Entity>(entity: E): readonly DeepReadonly<RecordOf[E]>[] {
    return [...(this.rows.get(entity)?.values() ?? [])] as DeepReadonly<RecordOf[E]>[];
  }

  byIndex<E extends Entity>(
    entity: E,
    index: IndexName<E>,
    value: string | null,
  ): readonly DeepReadonly<RecordOf[E]>[] {
    return this.all(entity).filter((record) => {
      const field = index === "dependency" ? "dependencies" : index;
      const item = Reflect.get(record, field);
      return Array.isArray(item) ? item.includes(value) : item === value;
    });
  }
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
