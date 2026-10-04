import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import {
  COLLECTIONS,
  keys,
  type CollectionKind,
  type PagedKind,
  type PageParams,
} from "./query-client";
import type {
  Change,
  EntityVersions,
  Id,
  Issue,
  MemberProfile,
  PageResult,
  WorkspaceSummary,
} from "./types";

type Pages<T> = InfiniteData<PageResult<T>>;
type Versioned = { id?: Id; user_id?: Id; version?: number };

const keyOf = (record: Versioned) => (record.id ?? record.user_id)!;

/** Keeps the newer copy, so a late response can't undo a write the cache already has. */
function newer<T extends Versioned>(cached: T, incoming: T): T {
  return incoming.version !== undefined &&
    cached.version !== undefined &&
    incoming.version < cached.version
    ? cached
    : incoming;
}

const byText =
  <T>(field: (r: T) => string, desc = false) =>
  (a: T, b: T) =>
    (desc ? -1 : 1) * field(a).localeCompare(field(b));
const byField = (name: string, desc = false) =>
  byText((r: Versioned) => {
    const value = (r as Record<string, unknown>)[name];
    return typeof value === "string" ? value : "";
  }, desc);

/** Matches the server's order for each collection, so local inserts land where a refetch would put them. */
const ORDER: Record<CollectionKind, (a: Versioned, b: Versioned) => number> = {
  teams: byField("name"),
  labels: byField("name"),
  projects: byField("name"),
  milestones: byField("name"),
  views: byField("name"),
  integrations: byField("name"),
  sprints: byField("starts_at"),
  invitations: byField("expires_at", true),
  alert_preferences: byField("user_id"),
};

/** Replaces, inserts or removes records in a whole list. */
function upsert<T extends Versioned>(
  list: T[],
  changes: Map<Id, T | null>,
  order: (a: T, b: T) => number,
): T[] {
  const seen = new Set<Id>();
  const next: T[] = [];
  for (const record of list) {
    const id = keyOf(record);
    if (!changes.has(id)) next.push(record);
    else {
      seen.add(id);
      const incoming = changes.get(id);
      if (incoming) next.push(newer(record, incoming));
    }
  }
  const added = [...changes].filter(([id, record]) => record && !seen.has(id));
  if (added.length === 0) return next;
  return [...next, ...added.map(([, record]) => record!)].sort(order);
}

/** Replaces or removes records already in a paginated list. Reports whether any were new. */
function patchPages<T extends Versioned>(
  data: Pages<T>,
  changes: Map<Id, T | null>,
): { data: Pages<T>; unseen: Id[] } {
  const seen = new Set<Id>();
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.flatMap((record) => {
      const id = keyOf(record);
      if (!changes.has(id)) return [record];
      seen.add(id);
      const incoming = changes.get(id);
      return incoming ? [newer(record, incoming)] : [];
    }),
  }));
  const unseen = [...changes].filter(([id, r]) => r && !seen.has(id)).map(([id]) => id);
  return { data: { ...data, pages }, unseen };
}

/** Whether a new record belongs in a list read with these parameters. */
function belongs(kind: PagedKind, params: PageParams, record: Record<string, unknown>) {
  if (kind === "activity") return !params.entity_id || record.entity_id === params.entity_id;
  if (kind === "comments" || kind === "time_entries")
    return !params.issue_id || record.issue_id === params.issue_id;
  return true;
}

/**
 * Writes changed records from a command response or the change feed into every cached query.
 * Lists that may gain rows refetch in the background, since only the server knows their filters.
 */
export function applyChanges(client: QueryClient, ws: Id, changes: Change[]) {
  if (changes.length === 0) return;
  const grouped = new Map<string, Map<Id, Versioned | null>>();
  for (const change of changes) {
    const group = grouped.get(change.entity) ?? new Map<Id, Versioned | null>();
    group.set(change.id, change.record as Versioned | null);
    grouped.set(change.entity, group);
  }

  const workspace = grouped.get("workspace")?.get(ws) as WorkspaceSummary | null | undefined;
  if (workspace) client.setQueryData(keys.workspace(ws), { workspace });

  const members = grouped.get("members") as Map<Id, MemberProfile | null> | undefined;
  if (members)
    client.setQueryData<MemberProfile[]>(
      keys.members(ws),
      (old) =>
        old &&
        upsert(
          old,
          members,
          byText((m) => m.display_name.toLowerCase()),
        ),
    );

  for (const kind of COLLECTIONS) {
    const group = grouped.get(kind);
    if (group)
      client.setQueryData<Versioned[]>(
        keys.collection(ws, kind),
        (old) => old && upsert(old, group, ORDER[kind]),
      );
  }

  const issues = grouped.get("issues") as Map<Id, Issue | null> | undefined;
  if (issues) {
    for (const [id, record] of issues) {
      if (record)
        client.setQueryData<Issue>(keys.issue(ws, id), (old) => old && newer(old, record));
      else void client.invalidateQueries({ queryKey: keys.issue(ws, id) });
    }
    client.setQueriesData<Pages<Issue>>(
      { queryKey: keys.issueLists(ws) },
      (old) => old && patchPages(old, issues).data,
    );
    // An edit can move an issue into or out of any filtered list.
    void client.invalidateQueries({ queryKey: keys.issueLists(ws) });
  }

  for (const kind of ["comments", "time_entries", "activity", "notifications"] as const) {
    const group = grouped.get(kind);
    if (!group) continue;
    for (const query of client.getQueryCache().findAll({ queryKey: keys.pages(ws, kind) })) {
      const old = query.state.data as Pages<Versioned> | undefined;
      if (!old) continue;
      const { data, unseen } = patchPages(old, group);
      client.setQueryData(query.queryKey, data);
      const params = (query.queryKey[4] ?? {}) as PageParams;
      if (unseen.some((id) => belongs(kind, params, group.get(id) as Record<string, unknown>)))
        void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
    }
  }

  // Report totals depend on almost everything.
  void client.invalidateQueries({ queryKey: keys.report(ws) });
}

/** Applies a local guess to every cached copy of matching issues until the server answers. */
export function patchIssues(client: QueryClient, ws: Id, patch: (issue: Issue) => Issue) {
  void client.cancelQueries({ queryKey: keys.issues(ws) });
  for (const [key, data] of client.getQueriesData<Issue | Pages<Issue>>({
    queryKey: keys.issues(ws),
  })) {
    if (!data) continue;
    client.setQueryData(
      key,
      key[3] === "detail"
        ? patch(data as Issue)
        : {
            ...data,
            pages: (data as Pages<Issue>).pages.map((page) => ({
              ...page,
              items: page.items.map(patch),
            })),
          },
    );
  }
}

function collect(value: unknown, into: EntityVersions, key: "id" | "user_id" = "id") {
  if (Array.isArray(value)) for (const item of value) collect(item, into, key);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const id = record[key];
    if (typeof id === "string" && typeof record.version === "number")
      into[id] = Math.max(into[id] ?? 0, record.version);
    for (const nested of Object.values(record)) collect(nested, into, key);
  }
}

/**
 * The newest version the cache holds for every record, for a command's `expected_versions`.
 * Memberships and alert preferences are keyed by user, so they have their own maps.
 */
export function knownVersions(client: QueryClient, ws: Id) {
  const records: EntityVersions = {};
  const memberships: EntityVersions = {};
  const preferences: EntityVersions = {};
  for (const [key, data] of client.getQueriesData({ queryKey: keys.all(ws) })) {
    if (key[2] === "members") collect(data, memberships);
    else if (key[2] === "collection" && key[3] === "alert_preferences")
      collect(data, preferences, "user_id");
    else if (key[2] !== "report") collect(data, records);
  }
  return { records, memberships, preferences };
}
