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
   * the command's meaning. Deep-cloned and frozen with the rest of the
   * mutation by `setPending`.
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
      | "team_number"
      | "former_team_id"
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

/** Overlay values as they were before a change, by entity and key. undefined means absent. */
type Journal = Map<Entity, Map<string, OverlayValue | undefined>>;

function mergeJournal(into: Journal, from: Journal): void {
  for (const [entity, table] of from) {
    const target = into.get(entity);
    if (target === undefined) into.set(entity, table);
    else for (const [key, value] of table) if (!target.has(key)) target.set(key, value);
  }
}

/** Structural comparison: same keys with the same values, arrays element-wise. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && arraysEqual(a, b);
  }
  return objectsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

function arraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
}

function objectsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
  );
}

/** Whether `list` begins with the elements of `prefix`, by identity. */
function startsWith<T>(list: readonly T[], prefix: readonly T[]): boolean {
  return list.length >= prefix.length && prefix.every((item, i) => item === list[i]);
}

function ingestTable(entity: Entity, list: readonly object[]): Map<string, AnyRecord> {
  const table = new Map<string, AnyRecord>();
  for (const raw of list) {
    const clean = ingest(entity, raw as unknown as RecordOf[Entity]);
    table.set(keyOf(entity, clean as unknown as RecordOf[Entity]), clean);
  }
  return table;
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

export function immutableCopy<T>(value: T): T {
  return deepFreeze(deepClone(value));
}

/** Normalize, then detach from the caller and freeze, so the store never holds caller-owned objects. */
export function ingest(entity: Entity, record: object): AnyRecord {
  const clean = immutableCopy(
    normalize(entity, record as RecordOf[Entity]),
  ) as unknown as AnyRecord;
  for (const def of defsFor(entity))
    if (!Array.isArray(def.values(clean)))
      throw new Error(`invalid ${entity}.${def.name} index values`);
  return clean;
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

export function teamNumber(teamId: string, number: number): string {
  return `${teamId}:${number}`;
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
  {
    entity: "issues",
    name: "team_number",
    values: (record) => {
      const issue = record as unknown as SyncIssue;
      return [
        teamNumber(issue.team_id, issue.number),
        ...issue.former_keys.map((key) => teamNumber(key.team_id, key.number)),
      ];
    },
  },
  {
    entity: "issues",
    name: "former_team_id",
    values: (record) => [
      ...new Set((record as unknown as SyncIssue).former_keys.map((key) => key.team_id)),
    ],
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

/**
 * What the replayed outbox read: point keys, index buckets and whole-table
 * scans. Writes read the current value first, so every written key is here
 * too. A base change outside this set cannot change any replay's outcome.
 */
class ReplayReads {
  private readonly keys = new Map<Entity, Set<string>>();
  private readonly buckets = new Map<IndexDef, Set<string>>();
  private readonly scans = new Set<Entity>();

  clear(): void {
    this.keys.clear();
    this.buckets.clear();
    this.scans.clear();
  }

  key(entity: Entity, key: string): void {
    addTo(this.keys, entity, key);
  }

  bucket(def: IndexDef, bucket: string): void {
    addTo(this.buckets, def, bucket);
  }

  scan(entity: Entity): void {
    this.scans.add(entity);
  }

  /** Whether a base record going from `before` to `after` is visible to any read. */
  sees(entity: Entity, key: string, before?: AnyRecord, after?: AnyRecord): boolean {
    if (this.scans.has(entity) || this.keys.get(entity)?.has(key) === true) return true;
    return defsFor(entity).some((def) => {
      const read = this.buckets.get(def);
      return read !== undefined && (inBuckets(def, before, read) || inBuckets(def, after, read));
    });
  }
}

function addTo<K>(sets: Map<K, Set<string>>, owner: K, value: string): void {
  let set = sets.get(owner);
  if (set === undefined) {
    set = new Set();
    sets.set(owner, set);
  }
  set.add(value);
}

function inBuckets(def: IndexDef, record: AnyRecord | undefined, read: Set<string>): boolean {
  return record !== undefined && def.values(record).some((value) => read.has(bucketOf(value)));
}

/** Record keys by index bucket. */
type Indexes = Map<IndexDef, Map<string, Set<string>>>;

function visible(value: OverlayValue | undefined): AnyRecord | undefined {
  return value === TOMBSTONE ? undefined : value;
}

function maintainIndex(
  indexes: Indexes,
  entity: Entity,
  key: string,
  before: AnyRecord | undefined,
  after: AnyRecord | undefined,
): void {
  for (const def of defsFor(entity)) {
    const from = new Set((before === undefined ? [] : def.values(before)).map(bucketOf));
    const to = new Set((after === undefined ? [] : def.values(after)).map(bucketOf));
    let buckets = indexes.get(def);
    if (buckets === undefined) {
      buckets = new Map();
      indexes.set(def, buckets);
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
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  // An Error's own name and message fill in when the object lacks usable ones.
  const fallback = value instanceof Error ? value : undefined;
  const rawMessage = record["message"];
  const message = rawMessage === undefined ? fallback?.message : String(rawMessage);
  const error: ReplayError = {
    name: stringField(record, "name") ?? fallback?.name ?? "Error",
    message: message ?? String(value),
  };
  const status = record["status"];
  if (typeof status === "number") error.status = status;
  const code = stringField(record, "code");
  if (code !== undefined) error.code = code;
  return deepFreeze(error);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function replayErrorEqual(a: ReplayError, b: ReplayError): boolean {
  return a.name === b.name && a.message === b.message && a.status === b.status && a.code === b.code;
}

/**
 * Base plus an overlay of replayed outbox mutations. Base changes only through
 * replaceBase and applyBase. A base change the outbox read, or an outbox
 * change other than an append, rebuilds the overlay from scratch; an append
 * replays only the new tail.
 */
export class SyncStore {
  private readonly replay: ReplayFn;
  private readonly base = emptyTables<AnyRecord>();
  private readonly baseIndexes: Indexes = new Map();
  private overlay = emptyTables<OverlayValue>();
  /** Overlay keys by index bucket, minus tombstones, so replay reads never walk the overlay. */
  private readonly overlayIndexes: Indexes = new Map();
  private readonly dirtyBase = new Map<Entity, Map<string, AnyRecord | undefined>>();
  private pendingList: readonly DeepReadonly<PendingMutation>[] = Object.freeze([]);
  /** The pending list the overlay reflects. */
  private replayed: readonly DeepReadonly<PendingMutation>[] = Object.freeze([]);
  private errors = new Map<number, ReplayError>();
  private readonly versions = new Map<Entity, number>();
  private pendingVer = 0;
  private notifiedPending: readonly DeepReadonly<PendingMutation>[] = Object.freeze([]);
  private notifiedErrors = new Map<number, ReplayError>();
  private readonly allCache = {} as Record<Entity, AllEntry>;
  private readonly viewIndexes = new Map<IndexDef, Map<string, ViewBucket>>();
  private readonly stageKinds = new Map<string, StageKind>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly tx: Tx;
  private batchDepth = 0;
  private isInRebase = false;
  private needsRebase = false;
  private activeJournal: Journal | null = null;
  /** Reads of the mutations the overlay reflects. */
  private readonly reads = new ReplayReads();
  /** Set while replaying, so admission dry runs don't record reads. */
  private recording: ReplayReads | null = null;

  /**
   * Test-only counters: lazy rebuilds, base rows visited by table scans, replayed mutations, and
   * overlay rows visited by replay index reads. Never reset by the store.
   */
  readonly debug = { allRebuilds: 0, indexRebuilds: 0, baseScans: 0, replays: 0, overlayReads: 0 };

  constructor(replay: ReplayFn) {
    this.replay = replay;
    for (const entity of ENTITIES) this.allCache[entity] = { rows: EMPTY, dirty: false };
    this.tx = {
      get: <E extends Entity>(entity: E, key: string): DeepReadonly<RecordOf[E]> | undefined => {
        this.recording?.key(entity, key);
        return this.viewOf(entity, key) as unknown as DeepReadonly<RecordOf[E]> | undefined;
      },
      put: <E extends Entity>(entity: E, record: DeepReadonly<RecordOf[E]>): void => {
        this.assertEntity(entity);
        const key = keyOf(entity, record as unknown as RecordOf[E]);
        this.recording?.key(entity, key);
        const current = this.viewOf(entity, key);
        const clean = ingest(entity, record);
        if (current !== undefined && deepEqual(current, clean)) return;
        this.journalTouch(entity, key);
        this.setOverlay(entity, key, clean);
      },
      delete: (entity: Entity, key: string): void => {
        this.assertEntity(entity);
        this.recording?.key(entity, key);
        if (this.viewOf(entity, key) === undefined) return;
        this.journalTouch(entity, key);
        this.setOverlay(entity, key, TOMBSTONE);
      },
      byIndex: <E extends Entity>(
        entity: E,
        index: IndexName<E>,
        value: string | null,
      ): readonly DeepReadonly<RecordOf[E]>[] => {
        const def = requireDef(entity, index as string);
        const bucket = bucketOf(value);
        this.recording?.bucket(def, bucket);
        const baseBucket = this.baseIndexes.get(def)?.get(bucket);
        const out: AnyRecord[] = [];
        if (baseBucket !== undefined) {
          for (const key of baseBucket) {
            if (this.overlay[entity].has(key)) continue;
            const record = this.base[entity].get(key);
            if (record !== undefined) out.push(record);
          }
        }
        for (const key of this.overlayIndexes.get(def)?.get(bucket) ?? []) {
          this.debug.overlayReads += 1;
          out.push(this.overlay[entity].get(key) as AnyRecord);
        }
        return Object.freeze(out) as unknown as readonly DeepReadonly<RecordOf[E]>[];
      },
      all: <E extends Entity>(entity: E): readonly DeepReadonly<RecordOf[E]>[] => {
        this.assertEntity(entity);
        this.recording?.scan(entity);
        return this.scanView(entity) as unknown as readonly DeepReadonly<RecordOf[E]>[];
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
    // Ingest everything first so a bad record leaves the base untouched.
    const incoming = new Map(
      covered.map((entity) => [entity, ingestTable(entity, records[entity] ?? [])] as const),
    );
    for (const [entity, table] of incoming) this.replaceBaseTable(entity, table);
    this.scheduleRebase();
  }

  private replaceBaseTable(entity: Entity, table: Map<string, AnyRecord>): void {
    const baseTable = this.base[entity];
    for (const [key, clean] of table) {
      const current = baseTable.get(key);
      if (current !== undefined && deepEqual(current, clean)) continue;
      this.stashBase(entity, key);
      baseTable.set(key, clean);
      maintainIndex(this.baseIndexes, entity, key, current, clean);
    }
    const doomed = [...this.scanBase(entity)].map(([key]) => key).filter((key) => !table.has(key));
    for (const key of doomed) {
      this.stashBase(entity, key);
      const before = baseTable.get(key);
      baseTable.delete(key);
      maintainIndex(this.baseIndexes, entity, key, before, undefined);
    }
  }

  /** Pull pages and scope loads: upsert or delete by change id. */
  applyBase(changes: readonly Change[]): void {
    for (const change of changes) this.assertEntity(change.entity);
    const cleans = changes.map((change) =>
      change.record === null ? undefined : ingest(change.entity, change.record),
    );
    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i] as Change;
      const table = this.base[change.entity];
      const clean = cleans[i];
      if (clean === undefined) {
        if (table.has(change.id)) {
          this.stashBase(change.entity, change.id);
          const before = table.get(change.id);
          table.delete(change.id);
          maintainIndex(this.baseIndexes, change.entity, change.id, before, undefined);
        }
        continue;
      }
      const current = table.get(change.id);
      if (current !== undefined && deepEqual(current, clean)) continue;
      this.stashBase(change.entity, change.id);
      table.set(change.id, clean);
      maintainIndex(this.baseIndexes, change.entity, change.id, current, clean);
    }
    this.scheduleRebase();
  }

  /** Mutations already in the outbox are kept by identity; new ones are detached and frozen. */
  setPending(mutations: readonly PendingMutation[]): void {
    const known = new Set<unknown>(this.pendingList);
    const clean = mutations.map((mutation) =>
      known.has(mutation) ? mutation : immutableCopy(mutation),
    );
    if (clean.length === this.pendingList.length && startsWith(clean, this.pendingList)) return;
    this.pendingList = Object.freeze(clean);
    this.scheduleRebase();
  }

  /**
   * Gives a pending mutation a new id, such as the one its outbox write allocated. Replays never
   * read ids, so the overlay stays as it is unless the new id moves the mutation in the list.
   */
  renamePending(from: number, to: number): void {
    const previous = this.pendingList.find((mutation) => mutation.id === from);
    if (previous === undefined) return;
    const index = this.pendingList.indexOf(previous);
    const renamed = Object.freeze({ ...previous, id: to });
    const list = this.pendingList.slice();
    list[index] = renamed;
    const before = list[index - 1]?.id ?? Number.NEGATIVE_INFINITY;
    const after = list[index + 1]?.id ?? Number.POSITIVE_INFINITY;
    if (before >= to || to >= after) {
      this.setPending(list.sort((a, b) => a.id - b.id));
      return;
    }
    this.pendingList = Object.freeze(list);
    const replayedAt = this.replayed.indexOf(previous);
    if (replayedAt >= 0) {
      const replayed = this.replayed.slice();
      replayed[replayedAt] = renamed;
      this.replayed = Object.freeze(replayed);
    }
    const error = this.errors.get(from);
    if (error !== undefined) {
      this.errors = new Map(this.errors);
      this.errors.delete(from);
      this.errors.set(to, error);
    }
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
    const journal: Journal = new Map();
    const previousJournal = this.activeJournal;
    this.activeJournal = journal;
    try {
      return fn(this.tx);
    } finally {
      this.rollback(journal);
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
    entry.rows = this.scanView(entity);
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
    const entry = this.viewIndexes.get(def)?.get(bucketOf(value));
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

  /** Base records in one index bucket, without the overlay. Point lookups, no table scan. */
  baseByIndex<E extends Entity>(
    entity: E,
    index: IndexName<E>,
    value: string | null,
  ): readonly DeepReadonly<RecordOf[E]>[] {
    const def = requireDef(entity, index as string);
    const out: AnyRecord[] = [];
    for (const key of this.baseIndexes.get(def)?.get(bucketOf(value)) ?? []) {
      const record = this.base[entity].get(key);
      if (record !== undefined) out.push(record);
    }
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

  private scanView(entity: Entity): readonly AnyRecord[] {
    const out: AnyRecord[] = [];
    const overlay = this.overlay[entity];
    for (const [key, record] of this.scanBase(entity)) {
      const visible = overlay.get(key) ?? record;
      if (visible !== TOMBSTONE) out.push(visible);
    }
    for (const [key, record] of overlay) {
      if (!this.base[entity].has(key) && record !== TOMBSTONE) out.push(record);
    }
    return Object.freeze(out);
  }

  private rollback(journal: Journal): void {
    for (const [entity, table] of journal) {
      for (const [key, previous] of table) this.setOverlay(entity, key, previous);
    }
  }

  /** The one way to write the overlay, so its index stays in step. `undefined` removes the key. */
  private setOverlay(entity: Entity, key: string, value: OverlayValue | undefined): void {
    const table = this.overlay[entity];
    const before = table.get(key);
    if (value === undefined) table.delete(key);
    else table.set(key, value);
    maintainIndex(this.overlayIndexes, entity, key, visible(before), visible(value));
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
    const prior = this.replayChanges();
    this.replayed = this.pendingList;
    const changed = this.diffView(prior);
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

  /**
   * Replays only the appended tail when the outbox grew and no base change
   * reaches a read of the replayed mutations; their overlay is then the same
   * on the new base. Anything else replays the whole outbox.
   */
  private replayChanges(): Journal {
    if (!startsWith(this.pendingList, this.replayed) || this.baseReachesReplay()) {
      return this.replayAll();
    }
    const prior: Journal = new Map();
    for (const [entity, table] of this.dirtyBase) {
      prior.set(entity, new Map([...table.keys()].map((key) => [key, undefined])));
    }
    mergeJournal(prior, this.replayFrom(this.replayed.length));
    return prior;
  }

  private baseReachesReplay(): boolean {
    for (const [entity, table] of this.dirtyBase) {
      for (const [key, before] of table) {
        if (this.reads.sees(entity, key, before, this.base[entity].get(key))) return true;
      }
    }
    return false;
  }

  /** Replays the whole outbox into a fresh overlay. Returns every key in the old or new overlay or changed in base. */
  private replayAll(): Journal {
    const prior: Journal = new Map();
    for (const entity of ENTITIES) {
      const table = new Map<string, OverlayValue | undefined>(this.overlay[entity]);
      for (const key of this.dirtyBase.get(entity)?.keys() ?? []) {
        if (!table.has(key)) table.set(key, undefined);
      }
      prior.set(entity, table);
    }
    this.overlay = emptyTables<OverlayValue>();
    this.overlayIndexes.clear();
    this.errors = new Map();
    this.reads.clear();
    mergeJournal(prior, this.replayFrom(0));
    return prior;
  }

  /** Replays pending mutations from `start` on top of the overlay. Returns the keys they touched. */
  private replayFrom(start: number): Journal {
    const touched: Journal = new Map();
    if (start > 0) this.errors = new Map(this.errors);
    for (const mutation of this.pendingList.slice(start)) {
      const journal: Journal = new Map();
      this.activeJournal = journal;
      this.recording = this.reads;
      this.debug.replays += 1;
      try {
        this.replay(this.tx, mutation);
      } catch (error) {
        this.rollback(journal);
        this.errors.set(mutation.id, toReplayError(error));
      } finally {
        this.activeJournal = null;
        this.recording = null;
      }
      mergeJournal(touched, journal);
    }
    return touched;
  }

  /** Compares the view before and after a rebase at every key in `prior`. */
  private diffView(prior: Journal): Map<Entity, ChangedView> {
    const oldView = (entity: Entity, key: string): AnyRecord | undefined => {
      const overlaid = prior.get(entity)?.get(key);
      if (overlaid !== undefined) return overlaid === TOMBSTONE ? undefined : overlaid;
      const dirty = this.dirtyBase.get(entity);
      if (dirty !== undefined && dirty.has(key)) return dirty.get(key);
      return this.base[entity].get(key);
    };
    const changed = new Map<Entity, ChangedView>();
    for (const [entity, keys] of prior) {
      const fresh = this.overlay[entity];
      for (const key of keys.keys()) {
        const old = oldView(entity, key);
        const next = this.viewOf(entity, key);
        if (deepEqual(old, next)) {
          if (old !== next && old !== undefined && next !== undefined) {
            // Equal but not identical: keep the old object as the visible one
            // wherever the new value lives, so get and the cached all/byIndex
            // arrays agree. Both are frozen, so swapping base entries leaves
            // base indexes unaffected.
            if (fresh.has(key)) fresh.set(key, old);
            else this.base[entity].set(key, old);
          } else if (next === undefined && !this.base[entity].has(key)) {
            this.setOverlay(entity, key, undefined);
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
    return changed;
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
    for (const def of defsFor(entity)) {
      let buckets = this.viewIndexes.get(def);
      if (buckets === undefined) {
        buckets = new Map();
        this.viewIndexes.set(def, buckets);
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
