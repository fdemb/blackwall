import { execFileSync } from "node:child_process";

export const postgresUrl = process.env.TEST_POSTGRES_URL;

/** Dollar-quotes text as a SQL literal. The corpus must not contain the delimiter. */
export function sqlText(value: string): string {
  if (value.includes("$q$")) throw new Error("sql literal contains its delimiter");
  return `$q$${value}$q$`;
}

/** Runs SQL through psql against TEST_POSTGRES_URL and returns one line per result row. */
export function psqlRows(sql: string): string[] {
  if (!postgresUrl) throw new Error("TEST_POSTGRES_URL is not set");
  const output = execFileSync("psql", [postgresUrl, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  });
  return output.split("\n").slice(0, -1);
}
