import type { StageKind, Team } from "../lib/types";
import { ENTITIES, keyOf, normalize } from "./records";
import type { Change, Entity, RecordOf, SyncIssue } from "./records";

/** Recursively readonly view of a record. Reads return frozen objects. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** A mutation waiting for the server, in outbox order. */
export interface PendingMutation {
  id: number;
  name: string;
  args: unknown;
  at: string;
  /**
   * Client-only data captured at admission, stored with the mutation and
   * never sent to the server. Replay uses it where re-deriving would change
   * the command's meaning, such as the notifications "mark all read" applied
   * to. Deep-cloned and frozen with the rest of the mutation by `setPending`.
   */
  local?: unknown;
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
  get<E extends Entity>(entity: E, key: string): DeepReadonly<RecordOf[E]> | undefined;
  put<E extends Entity>(entity: E, record: DeepReadonly<RecordOf[E]>): void;
  delete(entity: Entity, key: string): void;
  byIndex<E extends Entity>(
    entity: E,
    index: IndexName<E>,
    value: string | null,
  ): readonly DeepReadonly<RecordOf[E]>[];
  all<E extends Entity>(entity: E): readonly DeepReadonly<RecordOf[E]>[];
}

/** Replays one pending mutation against the view. Task 2b provides the real one. */
export type ReplayFn = (tx: Tx, mutation: DeepReadonly<PendingMutation>) => void;

/** What changed in one rebase: view changes plus outbox bookkeeping. */
export interface StoreEvent {
  entities: ReadonlySet<Entity>;
  keys: ReadonlyMap<Entity, ReadonlySet<string>>;
  pendingChanged: boolean;
  errorsChanged: boolean;
}

/** Previous name for StoreEvent. Kept for existing imports. */
export type ChangeSet = StoreEvent;

export type ChangeListener = (event: StoreEvent) => void;

type AnyRecord = Record<string, unknown>;

const TOMBSTONE: unique symbol = Symbol("tombstone");
type OverlayValue = AnyRecord | typeof TOMBSTONE;

type ChangedView = Map<string, { old: AnyRecord | undefined; next: AnyRecord | undefined }>;

/** Structural comparison: same keys with the same values, arrays element-wise. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  if (aArray || bArray) {
    if (!aArray || !bArray) return false;
    const aa = a as readonly unknown[];
    const bb = b as readonly unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i += 1) {
      if (!deepEqual(aa[i], bb[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => deepClone(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(item);
  }
  return out as T;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else if (!(value instanceof Date)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item, seen);
    }
  }
  return Object.freeze(value);
}

/** Normalize, then detach from the caller and freeze, so the store never holds caller-owned objects. */
function ingest<E extends Entity>(entity: E, record: DeepReadonly<RecordOf[E]>): AnyRecord {
  return deepFreeze(
    deepClone(normalize(entity, record as unknown as RecordOf[E])) as unknown as AnyRecord,
  );
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

function defsFor(entity: Entity): readonly IndexDef[] {
  return INDEX_DEFS.filter((def) => def.entity === entity);
}

interface ViewBucket {
  keys: Set<string>;
  rows: readonly AnyRecord[];
  dirty: boolean;
}

interface AllEntry {
  rows: readonly AnyRecord[];
  dirty: boolean;
}

/**
 * A replay failure, frozen. Replays may throw anything; the store converts it
 * here so error changes are observable per mutation id.
 */
export interface ReplayError {
  name: string;
  message: string;
  status?: number;
  code?: string;
}

/** Convert anything a replay throws into a frozen ReplayError. */
function toReplayError(value: unknown): ReplayError {
  let name: string | undefined;
  let message: string | undefined;
  let status: number | undefined;
  let code: string | undefined;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["name"] === "string") name = record["name"];
    if (typeof record["message"] === "string") message = record["message"];
    else if (record["message"] !== undefined) message = String(record["message"]);
    if (typeof record["status"] === "number") status = record["status"];
    if (typeof record["code"] === "string") code = record["code"];
  }
  if (value instanceof Error) {
    if (name === undefined) name = value.name;
    if (message === undefined) message = value.message;
  }
  const error: ReplayError = {
    name: name ?? "Error",
    message: message ?? String(value),
  };
  if (status !== undefined) error.status = status;
  if (code !== undefined) error.code = code;
  return deepFreeze(error);
}

function replayErrorEqual(a: ReplayError, b: ReplayError): boolean {
  return a.name === b.name && a.message === b.message && a.status === b.status && a.code === b.code;
}

/**
 * Base plus an overlay of replayed outbox mutations. Base changes only through
 * replaceBase and applyBase; the overlay is rebuilt from scratch on every rebase.
 */
export class SyncStore {
  private readonly replay: ReplayFn;
  private readonly base = emptyTables<AnyRecord>();
  private readonly baseIndexes = new Map<Entity, Map<string, Map<string, Set<string>>>>();
  private overlay = emptyTables<OverlayValue>();
  private readonly dirtyBase = new Map<Entity, Map<string, AnyRecord | undefined>>();
  private pendingList: readonly DeepReadonly<PendingMutation>[] = Object.freeze([]);
  private errors = new Map<number, ReplayError>();
  private readonly versions = new Map<Entity, number>();
  private pendingVer = 0;
  private notifiedPending: readonly DeepReadonly<PendingMutation>[] = Object.freeze([]);
  private notifiedErrors = new Map<number, ReplayError>();
  private readonly allCache = {} as Record<Entity, AllEntry>;
  private readonly viewIndexes = new Map<Entity, Map<string, Map<string, ViewBucket>>>();
  private readonly stageKinds = new Map<string, StageKind>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly tx: Tx;
  private batchDepth = 0;
  private isInRebase = false;
  private needsRebase = false;
  private activeJournal: Map<Entity, Map<string, OverlayValue | undefined>> | null = null;

  /** Test-only counters: lazy rebuilds and base rows visited by table scans. Never reset by the store. */
  readonly debug = { allRebuilds: 0, indexRebuilds: 0, baseScans: 0 };

  constructor(replay: ReplayFn) {
    this.replay = replay;
    for (const entity of ENTITIES) this.allCache[entity] = { rows: EMPTY, dirty: false };
    this.tx = {
      get: <E extends Entity>(entity: E, key: string): DeepReadonly<RecordOf[E]> | undefined =>
        this.viewOf(entity, key) as unknown as DeepReadonly<RecordOf[E]> | undefined,
      put: <E extends Entity>(entity: E, record: DeepReadonly<RecordOf[E]>): void => {
        this.assertEntity(entity);
        const key = keyOf(entity, record as unknown as RecordOf[E]);
        const current = this.viewOf(entity, key);
        const clean = ingest(entity, record);
        if (current !== undefined && deepEqual(current, clean)) return;
        this.journalTouch(entity, key);
        this.overlay[entity].set(key, clean as unknown as OverlayValue);
      },
      delete: (entity: Entity, key: string): void => {
        this.assertEntity(entity);
        if (this.viewOf(entity, key) === undefined) return;
        this.journalTouch(entity, key);
        this.overlay[entity].set(key, TOMBSTONE);
      },
      byIndex: <E extends Entity>(
        entity: E,
        index: IndexName<E>,
        value: string | null,
      ): readonly DeepReadonly<RecordOf[E]>[] => {
        const def = requireDef(entity, index as string);
        const bucket = bucketOf(value);
        const baseBucket = this.baseIndexes
          .get(entity)
          ?.get(index as string)
          ?.get(bucket);
        const out: AnyRecord[] = [];
        if (baseBucket !== undefined) {
          for (const key of baseBucket) {
            if (this.overlay[entity].has(key)) continue;
            const record = this.base[entity].get(key);
            if (record !== undefined) out.push(record);
          }
        }
        for (const [key, overlaid] of this.overlay[entity]) {
          void key;
          if (overlaid === TOMBSTONE) continue;
          if (def.values(overlaid).some((item) => item === value)) out.push(overlaid);
        }
        return Object.freeze(out) as unknown as readonly DeepReadonly<RecordOf[E]>[];
      },
      all: <E extends Entity>(entity: E): readonly DeepReadonly<RecordOf[E]>[] => {
        this.assertEntity(entity);
        const out: AnyRecord[] = [];
        const seen = new Set<string>();
        for (const [key, record] of this.scanBase(entity)) {
          const overlaid = this.overlay[entity].get(key);
          seen.add(key);
          if (overlaid === undefined) out.push(record);
          else if (overlaid !== TOMBSTONE) out.push(overlaid);
        }
        for (const [key, overlaid] of this.overlay[entity]) {
          if (!seen.has(key) && overlaid !== TOMBSTONE) out.push(overlaid);
        }
        return Object.freeze(out) as unknown as readonly DeepReadonly<RecordOf[E]>[];
      },
    };
  }

  /**
   * Bootstrap: each entity in `entities` is fully replaced. An entity with no
   * records ends up empty, so a bootstrap scope with no rows clears stale
   * records. Entities not listed are untouched, so comment and activity
   * scopes survive. The orchestrator passes BOOTSTRAP_ENTITIES.
   */
  replaceBase(
    records: Partial<Record<Entity, readonly object[]>>,
    entities: readonly Entity[],
  ): void {
    const covered = entities.slice();
    for (const entity of covered) this.assertEntity(entity);
    const incoming = new Map<Entity, Map<string, AnyRecord>>();
    for (const entity of covered) {
      const list = records[entity] ?? [];
      const table = new Map<string, AnyRecord>();
      for (const raw of list) {
        const clean = ingest(entity, raw as unknown as RecordOf[Entity]);
        table.set(keyOf(entity, clean as unknown as RecordOf[Entity]), clean);
      }
      incoming.set(entity, table);
    }
    for (const entity of covered) {
      const table = incoming.get(entity) as Map<string, AnyRecord>;
      const baseTable = this.base[entity];
      for (const [key, clean] of table) {
        const current = baseTable.get(key);
        if (current !== undefined && deepEqual(current, clean)) continue;
        this.stashBase(entity, key);
        const before = baseTable.get(key);
        baseTable.set(key, clean);
        this.maintainBaseIndex(entity, key, before, clean);
      }
      const doomed: string[] = [];
      for (const [key] of this.scanBase(entity)) {
        if (!table.has(key)) doomed.push(key);
      }
      for (const key of doomed) {
        this.stashBase(entity, key);
        const before = baseTable.get(key);
        baseTable.delete(key);
        this.maintainBaseIndex(entity, key, before, undefined);
      }
    }
    this.scheduleRebase();
  }

  /** Pull pages and scope loads: upsert or delete by change id. */
  applyBase(changes: readonly Change[]): void {
    for (const change of changes) this.assertEntity(change.entity);
    const cleans = new Map<number, AnyRecord | undefined>();
    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i] as Change;
      if (change.record === null) {
        cleans.set(i, undefined);
        continue;
      }
      cleans.set(i, ingest(change.entity, change.record as unknown as RecordOf[Entity]));
    }
    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i] as Change;
      const table = this.base[change.entity];
      const clean = cleans.get(i);
      if (clean === undefined) {
        if (table.has(change.id)) {
          this.stashBase(change.entity, change.id);
          const before = table.get(change.id);
          table.delete(change.id);
          this.maintainBaseIndex(change.entity, change.id, before, undefined);
        }
        continue;
      }
      const current = table.get(change.id);
      if (current !== undefined && deepEqual(current, clean)) continue;
      this.stashBase(change.entity, change.id);
      table.set(change.id, clean);
      this.maintainBaseIndex(change.entity, change.id, current, clean);
    }
    this.scheduleRebase();
  }

  setPending(mutations: readonly PendingMutation[]): void {
    const clean = Object.freeze(
      mutations.map((mutation) => deepFreeze(deepClone(mutation))),
    ) as readonly PendingMutation[];
    this.pendingList = clean;
    this.scheduleRebase();
  }

  /** Coalesce several writes into one rebase and one notification. */
  batch(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.needsRebase && !this.isInRebase) {
        this.runRebases();
      }
    }
  }

  /**
   * Runs `fn` against the current view and discards its writes. Admission
   * uses it to validate a mutation without entering the outbox, capturing
   * the returned client-only data for the pending mutation.
   */
  dryRun<T>(fn: (tx: Tx) => T): T {
    const journal = new Map<Entity, Map<string, OverlayValue | undefined>>();
    const previousJournal = this.activeJournal;
    this.activeJournal = journal;
    try {
      return fn(this.tx);
    } finally {
      for (const [entity, table] of journal) {
        const overlayTable = this.overlay[entity];
        for (const [key, previous] of table) {
          if (previous === undefined) overlayTable.delete(key);
          else overlayTable.set(key, previous);
        }
      }
      this.activeJournal = previousJournal;
    }
  }

  get<E extends Entity>(entity: E, key: string): DeepReadonly<RecordOf[E]> | undefined {
    this.assertEntity(entity);
    return this.viewOf(entity, key) as unknown as DeepReadonly<RecordOf[E]> | undefined;
  }

  /** Base record without the overlay. For persistence and debugging. */
  baseGet<E extends Entity>(entity: E, key: string): DeepReadonly<RecordOf[E]> | undefined {
    this.assertEntity(entity);
    return this.base[entity].get(key) as unknown as DeepReadonly<RecordOf[E]> | undefined;
  }

  /** Every record in the view. Stable identity until the contents change. */
  all<E extends Entity>(entity: E): readonly DeepReadonly<RecordOf[E]>[] {
    this.assertEntity(entity);
    const entry = this.allCache[entity];
    if (!entry.dirty) return entry.rows as unknown as readonly DeepReadonly<RecordOf[E]>[];
    const out: AnyRecord[] = [];
    const seen = new Set<string>();
    for (const [key, record] of this.scanBase(entity)) {
      const overlaid = this.overlay[entity].get(key);
      seen.add(key);
      if (overlaid === undefined) out.push(record);
      else if (overlaid !== TOMBSTONE) out.push(overlaid);
    }
    for (const [key, overlaid] of this.overlay[entity]) {
      if (!seen.has(key) && overlaid !== TOMBSTONE) out.push(overlaid);
    }
    entry.rows = Object.freeze(out);
    entry.dirty = false;
    this.debug.allRebuilds += 1;
    return entry.rows as unknown as readonly DeepReadonly<RecordOf[E]>[];
  }

  byIndex<E extends Entity>(
    entity: E,
    index: IndexName<E>,
    value: string | null,
  ): readonly DeepReadonly<RecordOf[E]>[] {
    const def = requireDef(entity, index as string);
    void def;
    let byName = this.viewIndexes.get(entity);
    if (byName === undefined) {
      byName = new Map();
      this.viewIndexes.set(entity, byName);
    }
    let buckets = byName.get(index as string);
    if (buckets === undefined) {
      buckets = new Map();
      byName.set(index as string, buckets);
    }
    const entry = buckets.get(bucketOf(value));
    if (entry === undefined) return EMPTY as unknown as readonly DeepReadonly<RecordOf[E]>[];
    if (!entry.dirty) return entry.rows as unknown as readonly DeepReadonly<RecordOf[E]>[];
    const rows: AnyRecord[] = [];
    for (const key of entry.keys) {
      const record = this.viewOf(entity, key);
      if (record !== undefined) rows.push(record);
    }
    entry.rows = Object.freeze(rows);
    entry.dirty = false;
    this.debug.indexRebuilds += 1;
    return entry.rows as unknown as readonly DeepReadonly<RecordOf[E]>[];
  }

  /** Base records without the overlay. For persistence; built on demand. */
  baseAll<E extends Entity>(entity: E): readonly DeepReadonly<RecordOf[E]>[] {
    this.assertEntity(entity);
    const out: AnyRecord[] = [];
    for (const [, record] of this.scanBase(entity)) out.push(record);
    return Object.freeze(out) as unknown as readonly DeepReadonly<RecordOf[E]>[];
  }

  pending(): readonly DeepReadonly<PendingMutation>[] {
    return this.pendingList;
  }

  /** Replay failures from the latest rebase, by mutation id. The mutations stay pending. */
  replayErrors(): ReadonlyMap<number, ReplayError> {
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

  /** Increments when the pending list or replay errors change. Status bindings read it. */
  pendingVersion(): number {
    return this.pendingVer;
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

  /**
   * The one way to iterate whole base tables. Counts every row visited so the
   * F6/F7 guards catch table scans in hot paths; index bucket lookups are
   * point reads and don't count.
   */
  private *scanBase(entity: Entity): Generator<[string, AnyRecord]> {
    for (const entry of this.base[entity]) {
      this.debug.baseScans += 1;
      yield entry;
    }
  }

  private journalTouch(entity: Entity, key: string): void {
    const journal = this.activeJournal;
    if (journal === null) return;
    let table = journal.get(entity);
    if (table === undefined) {
      table = new Map();
      journal.set(entity, table);
    }
    if (!table.has(key)) table.set(key, this.overlay[entity].get(key));
  }

  private stashBase(entity: Entity, key: string): void {
    let table = this.dirtyBase.get(entity);
    if (table === undefined) {
      table = new Map();
      this.dirtyBase.set(entity, table);
    }
    if (!table.has(key)) table.set(key, this.base[entity].get(key));
  }

  private maintainBaseIndex(
    entity: Entity,
    key: string,
    before: AnyRecord | undefined,
    after: AnyRecord | undefined,
  ): void {
    for (const def of defsFor(entity)) {
      const from = new Set((before === undefined ? [] : def.values(before)).map(bucketOf));
      const to = new Set((after === undefined ? [] : def.values(after)).map(bucketOf));
      let byName = this.baseIndexes.get(entity);
      if (byName === undefined) {
        byName = new Map();
        this.baseIndexes.set(entity, byName);
      }
      let buckets = byName.get(def.name);
      if (buckets === undefined) {
        buckets = new Map();
        byName.set(def.name, buckets);
      }
      for (const bucket of from) {
        if (to.has(bucket)) continue;
        const entry = buckets.get(bucket);
        if (entry !== undefined) {
          entry.delete(key);
          if (entry.size === 0) buckets.delete(bucket);
        }
      }
      for (const bucket of to) {
        if (from.has(bucket)) continue;
        let entry = buckets.get(bucket);
        if (entry === undefined) {
          entry = new Set();
          buckets.set(bucket, entry);
        }
        entry.add(key);
      }
    }
  }

  private scheduleRebase(): void {
    if (this.batchDepth > 0 || this.isInRebase) {
      this.needsRebase = true;
      return;
    }
    this.runRebases();
  }

  private runRebases(): void {
    if (this.isInRebase) {
      this.needsRebase = true;
      return;
    }
    this.isInRebase = true;
    try {
      let passes = 0;
      do {
        this.needsRebase = false;
        this.rebaseOnce();
        passes += 1;
        if (passes >= 100 && this.needsRebase) {
          // A subscriber keeps making real changes. The store is consistent
          // after this pass; the queued change stays flagged for the next
          // outermost call, which rebases again.
          throw new Error("sync store: rebase feedback loop");
        }
      } while (this.needsRebase);
    } finally {
      this.isInRebase = false;
    }
  }

  private rebaseOnce(): void {
    const oldOverlay = this.overlay;
    this.overlay = emptyTables<OverlayValue>();
    const fresh = this.overlay;
    const nextErrors = new Map<number, ReplayError>();
    for (const mutation of this.pendingList) {
      const journal = new Map<Entity, Map<string, OverlayValue | undefined>>();
      this.activeJournal = journal;
      try {
        this.replay(this.tx, mutation);
      } catch (error) {
        for (const [entity, table] of journal) {
          const freshTable = fresh[entity];
          for (const [key, previous] of table) {
            if (previous === undefined) freshTable.delete(key);
            else freshTable.set(key, previous);
          }
        }
        nextErrors.set(mutation.id, toReplayError(error));
      } finally {
        this.activeJournal = null;
      }
    }
    this.errors = nextErrors;

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
        if (deepEqual(old, next)) {
          if (old !== next && old !== undefined && next !== undefined) {
            // Equal but not identical: keep the old object as the visible one
            // wherever the new value lives, so get and the cached all/byIndex
            // arrays agree. Both are frozen, so swapping base entries leaves
            // base indexes unaffected.
            if (fresh[entity].has(key)) fresh[entity].set(key, old);
            else this.base[entity].set(key, old);
          } else if (fresh[entity].has(key)) {
            if (next === undefined) {
              if (!this.base[entity].has(key)) fresh[entity].delete(key);
            } else if (old !== undefined) {
              fresh[entity].set(key, old);
            }
          }
          continue;
        }
        let table = changed.get(entity);
        if (table === undefined) {
          table = new Map();
          changed.set(entity, table);
        }
        table.set(key, { old, next });
      }
    }
    this.dirtyBase.clear();

    const pendingChanged = !deepEqual(this.pendingList, this.notifiedPending);
    const freshErrors = this.errors;
    let errorsChanged = freshErrors.size !== this.notifiedErrors.size;
    if (!errorsChanged) {
      for (const [id, error] of freshErrors) {
        const previous = this.notifiedErrors.get(id);
        if (previous === undefined || !replayErrorEqual(previous, error)) {
          errorsChanged = true;
          break;
        }
      }
    }
    if (pendingChanged || errorsChanged) {
      this.pendingVer += 1;
      this.notifiedPending = this.pendingList;
      this.notifiedErrors = new Map(freshErrors);
    }

    if (changed.size === 0 && !pendingChanged && !errorsChanged) return;
    for (const [entity, table] of changed) {
      if (entity === "teams") this.updateStageKinds(table);
      this.invalidateView(entity, table);
      this.allCache[entity].dirty = true;
    }
    const entities = new Set<Entity>();
    const keys = new Map<Entity, ReadonlySet<string>>();
    for (const [entity, table] of changed) {
      entities.add(entity);
      keys.set(entity, new Set(table.keys()));
      this.versions.set(entity, (this.versions.get(entity) ?? 0) + 1);
    }
    const snapshot: StoreEvent = { entities, keys, pendingChanged, errorsChanged };
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

  private invalidateView(entity: Entity, changed: ChangedView): void {
    let byName = this.viewIndexes.get(entity);
    if (byName === undefined) {
      byName = new Map();
      this.viewIndexes.set(entity, byName);
    }
    for (const def of defsFor(entity)) {
      let buckets = byName.get(def.name);
      if (buckets === undefined) {
        buckets = new Map();
        byName.set(def.name, buckets);
      }
      for (const [key, { old, next }] of changed) {
        const from = new Set((old === undefined ? [] : def.values(old)).map(bucketOf));
        const to = new Set((next === undefined ? [] : def.values(next)).map(bucketOf));
        const union = new Set([...from, ...to]);
        for (const bucket of union) {
          if (from.has(bucket)) {
            buckets.get(bucket)?.keys.delete(key);
          }
          if (to.has(bucket)) {
            let entry = buckets.get(bucket);
            if (entry === undefined) {
              entry = { keys: new Set(), rows: EMPTY, dirty: true };
              buckets.set(bucket, entry);
            }
            entry.keys.add(key);
          }
          const entry = buckets.get(bucket);
          if (entry === undefined) continue;
          if (entry.keys.size === 0) buckets.delete(bucket);
          else entry.dirty = true;
        }
      }
    }
  }
}
