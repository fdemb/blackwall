import { describe, expect, it } from "vite-plus/test";
import { makeIssue } from "../sync/fixtures";
import { postgresUrl, psqlRows, sqlText } from "../testing/postgres";
import { KEY_CASES, SEARCH_CORPUS, type SearchCase } from "../testing/search-corpus";
import { matchesSearch } from "./issue-filter";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

/** Corpus cases where local search answers differently from the server, on purpose. */
const KNOWN_DIFFERENCES: readonly { title: string; search: string; reason: string }[] = [
  { title: "<b>bold</b> text", search: "b bold", reason: "the server skips HTML tags" },
  { title: "Install 1.2.3 now", search: "3 2", reason: "the server keeps 1.2.3 as one token" },
  {
    title: "naïve—test foo😀bar",
    search: "naïve-test",
    reason: "the server keeps hyphenated words whole",
  },
  {
    title: "pi is 3.14",
    search: "3 14",
    reason: "the server keeps decimals like 3.14 as one token",
  },
  {
    title: "see https://example.com/path?x=1 today",
    search: "path x 1",
    reason: "the server keeps a URL as one token",
  },
  {
    title: "write user@example.com here",
    search: "user example",
    reason: "the server keeps an email address as one token",
  },
  {
    title: "İstanbul",
    search: "istanbul",
    reason: "toLowerCase() turns İ into i plus a combining dot; the server keeps i",
  },
];

const caseKey = ({ title, search }: { title: string; search: string }) =>
  JSON.stringify([title, search]);

/** Every case the server comparison checks, each once. */
const CHECKED = [
  ...new Map(
    [...SEARCH_CORPUS, ...KEY_CASES.map(([item]) => item)].map((item) => [caseKey(item), item]),
  ).values(),
];

/** The server escapes LIKE wildcards in the search, so `%` and `_` match only themselves. */
function likePattern(search: string): string {
  const escaped = search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return `%${escaped}%`;
}

/** The server's text predicate, evaluated by PostgreSQL for every case in one query. */
function postgresMatches(cases: readonly SearchCase[]): boolean[] {
  const values = cases
    .map(
      (item, index) =>
        `(${index}, ${sqlText(item.title)}, ${sqlText(item.description)}, ${sqlText(item.search)}, ${sqlText(likePattern(item.search))})`,
    )
    .join(",\n");
  const rows = psqlRows(
    `select (to_tsvector('simple', t || ' ' || d) @@ plainto_tsquery('simple', s)) or ((t || ' ' || d) ILIKE p ESCAPE E'\\\\') from (values ${values}) v(n, t, d, s, p) order by n`,
  );
  return rows.map((row) => row === "t");
}

/** Cases where matchesSearch disagrees with the server. A blank search skips the filter there. */
function disagreements(cases: readonly SearchCase[]): SearchCase[] {
  const postgres = postgresMatches(cases);
  return cases.flatMap((item, index) => {
    const expected = item.search.trim() === "" ? true : postgres[index];
    const issue = makeIssue(id(2), {
      title: item.title,
      description: item.description,
      number: null,
    });
    return matchesSearch(issue, item.search) === expected ? [] : [item];
  });
}

function matchesCase(item: SearchCase): boolean {
  return matchesSearch(
    makeIssue(id(2), { title: item.title, description: item.description, number: null }),
    item.search,
  );
}

describe("search answers without PostgreSQL", () => {
  it.each(KEY_CASES)("answers %j for %j", (item, expected) => {
    expect(matchesCase(item)).toBe(expected);
  });
});

describe.skipIf(!postgresUrl)("search agrees with PostgreSQL", () => {
  it("answers every checked case the way the server does, except the known differences", () => {
    const differing = disagreements(CHECKED).map(caseKey).sort();
    expect(differing).toEqual(KNOWN_DIFFERENCES.map(caseKey).sort());
  });
});
