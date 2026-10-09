import { ApiError } from "./api";
import type { IssueFilter, Priority } from "./types";
import type { SyncStore, DeepReadonly } from "../sync/store";
import type { SyncIssue } from "../sync/records";
import { parseTimestamp } from "../sync/records";

const rank: Record<Priority, number> = { none: 0, low: 1, normal: 2, high: 3, urgent: 4 };
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
function nullable(a: string | number | null, b: string | number | null): number {
  return a === null ? (b === null ? 0 : 1) : b === null ? -1 : compare(a, b);
}

// PostgreSQL's default parser in en_US.utf8. Letters, marks and format characters form words, and
// so do non-ASCII digits. Symbols, punctuation, spaces, emoji and ASCII digits separate words. The
// simple dictionary keeps those lexemes, lowercased, with no stemming or stop words.
const WORD = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Nl}\p{Cf}]`;
const LETTER = String.raw`(?:[\p{Alphabetic}\p{M}\p{Cf}]|(?!\d)[\p{Nd}\p{Nl}])`;
const START = String.raw`(?:[\p{Alphabetic}]|(?!\d)[\p{Nd}\p{Nl}]|\d)`;
const wordPart = `${WORD}*${LETTER}${WORD}*`;
const compoundPattern = `${wordPart}(?:-${wordPart})+`;
// Hosts and emails are ASCII. A file name continues over hyphens and underscores after its first
// part, and a dot or slash starts a new part only when a letter, digit or underscore follows it.
const HOST = "[a-z0-9_-]";
const FILE_PART = "[a-z0-9_][a-z0-9_-]*";
// A non-ASCII first part must hold a digit, as in "é3.14e"; "café.example" splits at the dot.
const FILE_FIRST = `(?:(?=${WORD}*\\d)${WORD}+|[a-z0-9]+)`;
const FILE_PATH = `${FILE_FIRST}(?:[./]${FILE_PART})+`;
const ROOTED_PATH = String.raw`\/${FILE_PART}(?:[./]${FILE_PART})*`;
// Printable ASCII that a URL path keeps: no space, quotes, angle brackets, backslash, caret,
// backtick or braces.
const URL_CHAR = String.raw`[!#$%&'()*+,\-./0-9:;=?@A-Z\[\]_a-z|~]`;
const HOST_NAME = `${HOST}+(?:\\.${HOST}+)*\\.[a-z]{2,}(?::\\d+)?(?:\\/${URL_CHAR}*)?`;
const URL_TOKEN = new RegExp(`^${HOST_NAME}$`, "i");
const compoundWord = new RegExp(`^${compoundPattern}$`, "iu");
// Tokens are matched as written, so "İ" stays non-ASCII and breaks a path, as in PostgreSQL.
const searchTokens = new RegExp(
  [
    /<[^>]*>/,
    /&(?:#[xX][\da-f]+|#\d+|[a-z][a-z0-9]*);/,
    /[a-z]+:\/\//,
    `[a-z0-9_.-]+@${HOST}+(?:\\.${HOST}+)*\\.[a-z]{2,}`,
    HOST_NAME,
    /\d+(?:\.\d+){2,}/,
    /[+-]?\d+(?:\.\d+)?[eE][+-]?\d+/,
    /[+-]?\d+\.\d+(?!\.\d)/,
    compoundPattern,
    ROOTED_PATH,
    FILE_PATH,
    /[+-]\d+(?!\.?\d|\/)/,
    `${START}${WORD}*`,
  ]
    .map((pattern) => (typeof pattern === "string" ? pattern : pattern.source))
    .join("|"),
  "giu",
);

/** Lowercases one character at a time, as PostgreSQL does. U+0130 keeps its first lowercase form, i. */
function lowerPG(text: string): string {
  let out = "";
  for (const char of text) out += Array.from(char.toLowerCase())[0] ?? char;
  return out;
}

export function lexemes(text: string): string[] {
  const out: string[] = [];
  let compoundEnd = -1;
  for (const match of text.matchAll(searchTokens)) {
    const token = match[0];
    if (token.startsWith("<") || token.startsWith("&") || token.endsWith("://")) continue;
    if (compoundWord.test(token)) {
      out.push(lowerPG(token), ...token.split("-").map(lowerPG));
      compoundEnd = match.index + token.length;
    } else if (match.index === compoundEnd && /^-\d+$/.test(token)) {
      out.push(token.slice(1));
    } else {
      const path = token.indexOf("/");
      const lower = lowerPG(token);
      if (URL_TOKEN.test(token) && path > 0)
        out.push(lower, lower.slice(0, lower.indexOf("/")), lower.slice(lower.indexOf("/")));
      else out.push(lower);
    }
  }
  return out;
}

export function matchesSearch(issue: DeepReadonly<SyncIssue>, search: string): boolean {
  if (!search.trim()) return true;
  const text = lowerPG(`${issue.title} ${issue.description}`);
  if (text.includes(lowerPG(search))) return true;
  const query = lexemes(search);
  const document = new Set(lexemes(text));
  if (query.length > 0 && query.every((word) => document.has(word))) return true;
  const raw = search.replace(/^#+/, "");
  return (
    /^[1-9]\d*$/.test(raw) &&
    BigInt(raw) <= 9223372036854775807n &&
    issue.number !== null &&
    String(issue.number) === raw
  );
}

type ReplicaIssueFilter = { [Key in keyof IssueFilter]: IssueFilter[Key] | null };

function uuid(value: string): string | undefined {
  let raw = value.startsWith("urn:uuid:") ? value.slice(9) : value;
  if (raw.startsWith("{") && raw.endsWith("}")) raw = raw.slice(1, -1);
  if (/^[\da-f]{32}$/i.test(raw))
    raw = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(raw)
    ? raw.toLowerCase()
    : undefined;
}

export function filterIssues(
  store: SyncStore,
  filter: ReplicaIssueFilter = {},
): DeepReadonly<SyncIssue>[] {
  if (filter.search && new TextEncoder().encode(filter.search).length > 200)
    throw new ApiError("search query too long", 400);
  let ids: Set<string> | undefined;
  if (filter.ids != null) {
    const values = filter.ids.split(",");
    if (values.some((id) => uuid(id) === undefined))
      throw new ApiError("ids must be comma-separated UUIDs", 400);
    if (values.length > 200) throw new ApiError("ids may contain at most 200 UUIDs", 400);
    ids = new Set(values.flatMap((id) => uuid(id) ?? []));
  }
  const due = filter.due_before == null ? undefined : parseTimestamp(filter.due_before);
  const rows = store.all("issues").filter((issue) => {
    if (
      filter.trash
        ? issue.deleted_at === null
        : issue.deleted_at !== null ||
          (filter.archived ? issue.archived_at === null : issue.archived_at !== null)
    )
      return false;
    for (const column of [
      "assignee",
      "created_by",
      "team_id",
      "stage_id",
      "sprint_id",
      "project_id",
      "parent_id",
      "priority",
    ] as const) {
      const value = filter[column];
      const actual = issue[column];
      if (value != null && (actual === null || (uuid(value) ?? value) !== (uuid(actual) ?? actual)))
        return false;
    }
    if (
      filter.label_id != null &&
      !issue.labels.some((id) => id === (uuid(filter.label_id ?? "") ?? filter.label_id))
    )
      return false;
    if (
      filter.dependency_id != null &&
      !issue.dependencies.some(
        (id) => id === (uuid(filter.dependency_id ?? "") ?? filter.dependency_id),
      )
    )
      return false;
    if (due !== undefined && (issue.deadline === null || issue.deadline > due)) return false;
    if (filter.unassigned && issue.assignee !== null) return false;
    if (filter.no_sprint && issue.sprint_id !== null) return false;
    if (filter.open) {
      const kind = store.stageKind(issue.stage_id);
      if (kind === undefined || kind === "done" || kind === "cancelled") return false;
    }
    if (ids && !ids.has(issue.id)) return false;
    return filter.search == null || matchesSearch(issue, filter.search);
  });
  return rows.sort((a, b) => {
    let group = 0;
    if (filter.group_by === "stage") group = compare(a.stage_id, b.stage_id);
    if (filter.group_by === "priority") group = rank[b.priority] - rank[a.priority];
    if (filter.group_by === "assignee") group = nullable(a.assignee, b.assignee);
    if (group) return group;
    switch (filter.sort ?? "position") {
      case "deadline":
        return nullable(a.deadline, b.deadline) || a.position - b.position || compare(a.id, b.id);
      case "updated":
        return compare(b.updated_at, a.updated_at) || compare(a.id, b.id);
      case "priority":
        return (
          rank[b.priority] - rank[a.priority] || a.position - b.position || compare(a.id, b.id)
        );
      case "position":
        return a.position - b.position || nullable(a.number, b.number) || compare(a.id, b.id);
    }
  });
}
