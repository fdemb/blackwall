import type { StageKind, Team } from "../lib/types";
import { ENTITIES, keyOf, normalize } from "./records";
import type { Change, Entity, RecordOf, SyncIssue } from "./records";

/** A mutation waiting for the server, in outbox order. */
export interface PendingMutation {
  id: number;
  name: string;
  args: unknown;
  at: string;
}

/** Index names per entity. Part of the store API. */
export type IndexName<E extends Entity> = E extends "issues"
  ?
      | "team_id"
      | "stage_id"
      | "parent_id"
      | "sprint_id"
      | "project_id"
      | "milestone_id"
      | "assignee"
      | "dependency"
  : E extends "comments"
    ? "issue_id"
    : E extends "time_entries"
      ? "issue_id" | "user_id"
      : E extends "activity"
        ? "entity_id"
        : E extends "milestones"
          ? "project_id"
          : E extends "sprints"
            ? "team_id"
            : E extends "notifications"
              ? "issue_id"
              : never;

/** Reads and writes the view inside a replay. Reads see earlier writes from the same replay. */
export interface Tx {
  get<E extends Entity>(entity: E, key: string): RecordOf[E] | undefined;
  put<E extends Entity>(entity: E, record: RecordOf[E]): void;
  delete(entity: Entity, key: string): void;
  byIndex<E extends Entity>(
    entity: E,
    index: IndexName<E>,
    value: string | null,
  ): readonly RecordOf[E][];
  all<E extends Entity>(entity: E): readonly RecordOf[E][];
}

/** Replays one pending mutation against the view. Task 2b provides the real one. */
export type ReplayFn = (tx: Tx, mutation: PendingMutation) => void;

/** What changed in one rebase: the entities and keys whose view value changed. */
export interface ChangeSet {
  entities: ReadonlySet<Entity>;
  keys: ReadonlyMap<Entity, ReadonlySet<string>>;
}

export type ChangeListener = (change: ChangeSet) => void;

type AnyRecord = Record<string, unknown>;

const TOMBSTONE: unique symbol = Symbol("tombstone");
type OverlayValue = AnyRecord | typeof TOMBSTONE;

type ChangedView = Map<string, { old: AnyRecord | undefined; next: AnyRecord | undefined }>;

/** Equal content keeps object identity, so unchanged rows never notify. */
function sameValue(a: AnyRecord, b: AnyRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyTables<T>(): Record<Entity, Map<string, T>> {
  const tables = {} as Record<Entity, Map<string, T>>;
  for (const entity of ENTITIES) tables[entity] = new Map();
  return tables;
}

const KNOWN_ENTITIES: ReadonlySet<string> = new Set(ENTITIES);
const EMPTY: readonly AnyRecord[] = Object.freeze([]);
const NULL_BUCKET = "\0";

function bucketOf(value: string | null): string {
  return value === null ? NULL_BUCKET : value;
}

function scalar(record: AnyRecord, key: string): string | null {
  const value: unknown = record[key];
  return typeof value === "string" ? value : null;
}

interface IndexDef {
  entity: Entity;
  name: string;
  values: (record: AnyRecord) => readonly (string | null)[];
}

function field<E extends Entity>(entity: E, name: IndexName<E>, key: string): IndexDef {
  return { entity, name, values: (record) => [scalar(record, key)] };
}

const INDEX_DEFS: readonly IndexDef[] = [
  field("issues", "team_id", "team_id"),
  field("issues", "stage_id", "stage_id"),
  field("issues", "parent_id", "parent_id"),
  field("issues", "sprint_id", "sprint_id"),
  field("issues", "project_id", "project_id"),
  field("issues", "milestone_id", "milestone_id"),
  field("issues", "assignee", "assignee"),
  {
    entity: "issues",
    name: "dependency",
    values: (record) => (record as unknown as SyncIssue).dependencies,
  },
  field("comments", "issue_id", "issue_id"),
  field("time_entries", "issue_id", "issue_id"),
  field("time_entries", "user_id", "user_id"),
  field("activity", "entity_id", "entity_id"),
  field("milestones", "project_id", "project_id"),
  field("sprints", "team_id", "team_id"),
  field("notifications", "issue_id", "issue_id"),
];

function requireDef(entity: Entity, name: string): IndexDef {
  const def = INDEX_DEFS.find(
    (candidate) => candidate.entity === entity && candidate.name === name,
  );
  if (def === undefined) throw new Error(`unknown index ${entity}.${name}`);
  return def;
}

interface Bucket {
  keys: Set<string>;
  rows: readonly AnyRecord[];
}

/**
 * Base plus an overlay of replayed outbox mutations. Base changes only through
 * replaceBase and applyBase; the overlay is rebuilt from scratch on every rebase.
 */
export class SyncStore {
  private readonly replay: ReplayFn;
  private readonly base = emptyTables<AnyRecord>();
  private overlay = emptyTables<OverlayValue>();
  private readonly dirtyBase = new Map<Entity, Map<string, AnyRecord | undefined>>();
  private pendingList: readonly PendingMutation[] = Object.freeze([]);
  private errors = new Map<number, unknown>();
  private readonly versions = new Map<Entity, number>();
  private readonly allCache: Record<Entity, readonly AnyRecord[]> = {} as Record<
    Entity,
    readonly AnyRecord[]
  >;
  private readonly allPos = emptyTables<number>();
  private readonly indexes = new Map<Entity, Map<string, Map<string, Bucket>>>();
  private readonly stageKinds = new Map<string, StageKind>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly tx: Tx;
  private batchDepth = 0;
  private needsRebase = false;

  constructor(replay: ReplayFn) {
    this.replay = replay;
    for (const entity of ENTITIES) this.allCache[entity] = EMPTY;
    this.tx = {
      get: <E extends Entity>(entity: E, key: string): RecordOf[E] | undefined =>
        this.viewOf(entity, key) as unknown as RecordOf[E] | undefined,
      put: <E extends Entity>(entity: E, record: RecordOf[E]): void => {
        this.assertEntity(entity);
        const key = keyOf(entity, record);
        const clean = normalize(entity, record);
        const current = this.viewOf(entity, key);
        if (current !== undefined && sameValue(current, clean as unknown as AnyRecord)) return;
        this.overlay[entity].set(key, clean as unknown as OverlayValue);
      },
      delete: (entity: Entity, key: string): void => {
        this.assertEntity(entity);
        this.overlay[entity].set(key, TOMBSTONE);
      },
      byIndex: <E extends Entity>(
        entity: E,
        index: IndexName<E>,
        value: string | null,
      ): readonly RecordOf[E][] => {
        const def = requireDef(entity, index as string);
        const out: AnyRecord[] = [];
        const seen = new Set<string>();
        for (const [key, record] of this.base[entity]) {
          const overlaid = this.overlay[entity].get(key);
          const current =
            overlaid === undefined ? record : overlaid === TOMBSTONE ? undefined : overlaid;
          seen.add(key);
          if (current !== undefined && def.values(current).some((item) => item === value)) {
            out.push(current);
          }
        }
        for (const [key, overlaid] of this.overlay[entity]) {
          if (seen.has(key) || overlaid === TOMBSTONE) continue;
          if (def.values(overlaid).some((item) => item === value)) out.push(overlaid);
        }
        return Object.freeze(out) as unknown as readonly RecordOf[E][];
      },
      all: <E extends Entity>(entity: E): readonly RecordOf[E][] => {
        this.assertEntity(entity);
        const out: AnyRecord[] = [];
        const seen = new Set<string>();
        for (const [key, record] of this.base[entity]) {
          const overlaid = this.overlay[entity].get(key);
          seen.add(key);
          if (overlaid === undefined) out.push(record);
          else if (overlaid !== TOMBSTONE) out.push(overlaid);
        }
        for (const [key, overlaid] of this.overlay[entity]) {
          if (!seen.has(key) && overlaid !== TOMBSTONE) out.push(overlaid);
        }
        return Object.freeze(out) as unknown as readonly RecordOf[E][];
      },
    };
  }

  /** Bootstrap: each listed entity is cleared and replaced. Unlisted entities are untouched. */
  replaceBase(records: Partial<Record<Entity, readonly object[]>>): void {
    for (const entity of ENTITIES) {
      const list = records[entity];
      if (list === undefined) continue;
      const incoming = new Map<string, AnyRecord>();
      for (const raw of list) {
        const clean = Object.freeze(
          normalize(entity, raw as unknown as RecordOf[Entity]),
        ) as unknown as AnyRecord;
        incoming.set(keyOf(entity, clean as unknown as RecordOf[Entity]), clean);
      }
      const table = this.base[entity];
      for (const [key, clean] of incoming) {
        const current = table.get(key);
        if (current !== undefined && sameValue(current, clean)) continue;
        this.stashBase(entity, key);
        table.set(key, clean);
      }
      for (const key of table.keys()) {
        if (!incoming.has(key)) {
          this.stashBase(entity, key);
          table.delete(key);
        }
      }
    }
    this.scheduleRebase();
  }

  /** Pull pages and scope loads: upsert or delete by change id. */
  applyBase(changes: readonly Change[]): void {
    for (const change of changes) {
      this.assertEntity(change.entity);
      const table = this.base[change.entity];
      if (change.record === null) {
        if (table.has(change.id)) {
          this.stashBase(change.entity, change.id);
          table.delete(change.id);
        }
        continue;
      }
      const clean = Object.freeze(
        normalize(change.entity, change.record as unknown as RecordOf[Entity]),
      ) as unknown as AnyRecord;
      const current = table.get(change.id);
      if (current !== undefined && sameValue(current, clean)) continue;
      this.stashBase(change.entity, change.id);
      table.set(change.id, clean);
    }
    this.scheduleRebase();
  }

  setPending(mutations: readonly PendingMutation[]): void {
    this.pendingList = Object.freeze([...mutations]);
    this.scheduleRebase();
  }

  /** Coalesce several writes into one rebase and one notification. */
  batch(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.needsRebase) {
        this.needsRebase = false;
        this.rebase();
      }
    }
  }

  get<E extends Entity>(entity: E, key: string): RecordOf[E] | undefined {
    this.assertEntity(entity);
    return this.viewOf(entity, key) as unknown as RecordOf[E] | undefined;
  }

  /** Every record in the view. Stable identity until the entity changes. */
  all<E extends Entity>(entity: E): readonly RecordOf[E][] {
    this.assertEntity(entity);
    return this.allCache[entity] as unknown as readonly RecordOf[E][];
  }

  byIndex<E extends Entity>(
    entity: E,
    index: IndexName<E>,
    value: string | null,
  ): readonly RecordOf[E][] {
    const bucket = this.indexes
      .get(entity)
      ?.get(index as string)
      ?.get(bucketOf(value));
    if (bucket === undefined) requireDef(entity, index as string);
    return (bucket?.rows ?? EMPTY) as unknown as readonly RecordOf[E][];
  }

  /** Base records without the overlay. For persistence; built on demand. */
  baseAll<E extends Entity>(entity: E): readonly RecordOf[E][] {
    this.assertEntity(entity);
    return Object.freeze([...this.base[entity].values()]) as unknown as readonly RecordOf[E][];
  }

  pending(): readonly PendingMutation[] {
    return this.pendingList;
  }

  /** Replay failures from the latest rebase, by mutation id. The mutations stay pending. */
  replayErrors(): ReadonlyMap<number, unknown> {
    return this.errors;
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Increments when the entity's view changes. React bindings subscribe on it. */
  version(entity: Entity): number {
    this.assertEntity(entity);
    return this.versions.get(entity) ?? 0;
  }

  /** Stage kind from the teams in view. Unknown stages return undefined. */
  stageKind(stageId: string): StageKind | undefined {
    return this.stageKinds.get(stageId);
  }

  private assertEntity(entity: Entity): void {
    if (!KNOWN_ENTITIES.has(entity)) throw new Error(`unknown entity ${String(entity)}`);
  }

  private viewOf(entity: Entity, key: string): AnyRecord | undefined {
    const overlaid = this.overlay[entity].get(key);
    if (overlaid !== undefined) return overlaid === TOMBSTONE ? undefined : overlaid;
    return this.base[entity].get(key);
  }

  private stashBase(entity: Entity, key: string): void {
    let table = this.dirtyBase.get(entity);
    if (table === undefined) {
      table = new Map();
      this.dirtyBase.set(entity, table);
    }
    if (!table.has(key)) table.set(key, this.base[entity].get(key));
  }

  private scheduleRebase(): void {
    if (this.batchDepth > 0) {
      this.needsRebase = true;
      return;
    }
    this.rebase();
  }

  private rebase(): void {
    const oldOverlay = this.overlay;
    this.overlay = emptyTables<OverlayValue>();
    this.errors = new Map();
    for (const mutation of this.pendingList) {
      try {
        this.replay(this.tx, mutation);
      } catch (error) {
        this.errors.set(mutation.id, error);
      }
    }
    const fresh = this.overlay;
    const candidates = new Map<Entity, Set<string>>();
    const add = (entity: Entity, key: string): void => {
      let keys = candidates.get(entity);
      if (keys === undefined) {
        keys = new Set();
        candidates.set(entity, keys);
      }
      keys.add(key);
    };
    for (const [entity, table] of this.dirtyBase) for (const key of table.keys()) add(entity, key);
    for (const entity of ENTITIES) {
      for (const key of oldOverlay[entity].keys()) add(entity, key);
      for (const key of fresh[entity].keys()) add(entity, key);
    }
    const oldView = (entity: Entity, key: string): AnyRecord | undefined => {
      const overlaid = oldOverlay[entity].get(key);
      if (overlaid !== undefined) return overlaid === TOMBSTONE ? undefined : overlaid;
      const dirty = this.dirtyBase.get(entity);
      if (dirty !== undefined && dirty.has(key)) return dirty.get(key);
      return this.base[entity].get(key);
    };
    const newView = (entity: Entity, key: string): AnyRecord | undefined => {
      const overlaid = fresh[entity].get(key);
      if (overlaid !== undefined) return overlaid === TOMBSTONE ? undefined : overlaid;
      return this.base[entity].get(key);
    };
    const changed = new Map<Entity, ChangedView>();
    for (const [entity, keys] of candidates) {
      for (const key of keys) {
        const old = oldView(entity, key);
        const next = newView(entity, key);
        if (old !== next) {
          let table = changed.get(entity);
          if (table === undefined) {
            table = new Map();
            changed.set(entity, table);
          }
          table.set(key, { old, next });
        }
      }
    }
    this.dirtyBase.clear();
    if (changed.size === 0) return;
    for (const [entity, table] of changed) {
      if (entity === "teams") this.updateStageKinds(table);
      this.updateIndexes(entity, table);
      this.updateAll(entity, table);
    }
    const entities = new Set<Entity>();
    const keys = new Map<Entity, ReadonlySet<string>>();
    for (const [entity, table] of changed) {
      entities.add(entity);
      keys.set(entity, new Set(table.keys()));
      this.versions.set(entity, (this.versions.get(entity) ?? 0) + 1);
    }
    const snapshot: ChangeSet = { entities, keys };
    for (const listener of [...this.listeners]) listener(snapshot);
  }

  private updateStageKinds(changed: ChangedView): void {
    for (const { old, next } of changed.values()) {
      const before = (old as unknown as Team | undefined)?.stages ?? [];
      const after = (next as unknown as Team | undefined)?.stages ?? [];
      const keep = new Set(after.map((stage) => stage.id));
      for (const stage of before) {
        if (!keep.has(stage.id)) this.stageKinds.delete(stage.id);
      }
      for (const stage of after) this.stageKinds.set(stage.id, stage.kind);
    }
  }

  private updateIndexes(entity: Entity, changed: ChangedView): void {
    for (const def of INDEX_DEFS) {
      if (def.entity !== entity) continue;
      let byName = this.indexes.get(entity);
      if (byName === undefined) {
        byName = new Map();
        this.indexes.set(entity, byName);
      }
      let buckets = byName.get(def.name);
      if (buckets === undefined) {
        buckets = new Map();
        byName.set(def.name, buckets);
      }
      const touched = new Set<string>();
      for (const [key, { old, next }] of changed) {
        const from = new Set((old === undefined ? [] : def.values(old)).map(bucketOf));
        const to = new Set((next === undefined ? [] : def.values(next)).map(bucketOf));
        for (const bucket of from) {
          if (to.has(bucket)) continue;
          buckets.get(bucket)?.keys.delete(key);
          touched.add(bucket);
        }
        for (const bucket of to) {
          if (from.has(bucket)) continue;
          let entry = buckets.get(bucket);
          if (entry === undefined) {
            entry = { keys: new Set(), rows: EMPTY };
            buckets.set(bucket, entry);
          }
          entry.keys.add(key);
          touched.add(bucket);
        }
      }
      for (const bucket of touched) {
        const entry = buckets.get(bucket);
        if (entry === undefined) continue;
        if (entry.keys.size === 0) {
          buckets.delete(bucket);
        } else {
          const rows: AnyRecord[] = [];
          for (const key of entry.keys) {
            const record = this.viewOf(entity, key);
            if (record !== undefined) rows.push(record);
          }
          entry.rows = Object.freeze(rows);
        }
      }
    }
  }

  private updateAll(entity: Entity, changed: ChangedView): void {
    if (changed.size === 0) return;
    const draft = [...this.allCache[entity]];
    const positions = this.allPos[entity];
    for (const [key, { old, next }] of changed) {
      if (next === undefined) {
        const index = positions.get(key);
        if (index === undefined) continue;
        positions.delete(key);
        const last = draft.pop() as AnyRecord;
        if (index < draft.length) {
          draft[index] = last;
          positions.set(keyOf(entity, last as unknown as RecordOf[Entity]), index);
        }
      } else if (old === undefined) {
        positions.set(key, draft.length);
        draft.push(next);
      } else {
        const index = positions.get(key);
        if (index === undefined) {
          positions.set(key, draft.length);
          draft.push(next);
        } else {
          draft[index] = next;
        }
      }
    }
    this.allCache[entity] = Object.freeze(draft);
  }
}
