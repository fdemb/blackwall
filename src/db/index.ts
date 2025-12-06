import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// import { queryLogger } from "./query-logging.server";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");

const client = new Database(process.env.DATABASE_URL);

const db = drizzle({
  client,
  schema,
  casing: "snake_case",
  // logger: queryLogger,
});

const dbSchema = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export { db, dbSchema, type DbTransaction };
