import { describe, expect, it } from "vite-plus/test";
import { makeIssue } from "../sync/fixtures";
import { postgresUrl, psqlRows, sqlText } from "../testing/postgres";
import { KEY_CASES, SEARCH_CORPUS, type SearchCase } from "../testing/search-corpus";
import { lexemes, matchesSearch } from "./issue-filter";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

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

/** The lexeme set PostgreSQL indexes for each case's document, one query for every case. */
function postgresLexemes(cases: readonly SearchCase[]): string[][] {
  const values = cases
    .map((item, index) => `(${index}, ${sqlText(`${item.title} ${item.description}`)})`)
    .join(",\n");
  const rows = psqlRows(
    `select v.n, t.lexeme from (values ${values}) v(n, s) cross join lateral unnest(to_tsvector('simple', v.s)) as t(lexeme) order by v.n, t.lexeme`,
  );
  const out: string[][] = cases.map(() => []);
  for (const row of rows) {
    const bar = row.indexOf("|");
    out[Number(row.slice(0, bar))].push(row.slice(bar + 1));
  }
  return out;
}

/** Cases where matchesSearch disagrees with the server. A blank search skips the filter there. */
function disagreements(cases: readonly SearchCase[]) {
  const postgres = postgresMatches(cases);
  return cases.flatMap((item, index) => {
    const expected = item.search.trim() === "" ? true : postgres[index];
    const issue = makeIssue(id(2), {
      title: item.title,
      description: item.description,
      number: null,
    });
    const actual = matchesSearch(issue, item.search);
    return actual === expected ? [] : [{ ...item, expected, actual }];
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
  it("answers every corpus case the way the server does", () => {
    expect(disagreements(SEARCH_CORPUS)).toEqual([]);
  });
  it("answers the key cases the way the server does", () => {
    expect(disagreements(KEY_CASES.map(([item]) => item))).toEqual([]);
  });
  it("indexes the same lexemes as to_tsvector for every corpus document", () => {
    const expected = postgresLexemes(SEARCH_CORPUS);
    const actual = SEARCH_CORPUS.map((item) =>
      [...new Set(lexemes(`${item.title} ${item.description}`))].sort(),
    );
    const mismatches = SEARCH_CORPUS.flatMap((item, index) =>
      JSON.stringify(actual[index]) === JSON.stringify([...new Set(expected[index])].sort())
        ? []
        : [
            {
              text: `${item.title} ${item.description}`,
              actual: actual[index],
              expected: expected[index],
            },
          ],
    );
    expect(mismatches).toEqual([]);
  });
});
