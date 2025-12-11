import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// import { queryLogger } from "./query-logging.server";
import { env } from "@/lib/zod-env";
import * as schema from "./schema";

const client = new Database(env.DATABASE_URL);
client.run("PRAGMA journal_mode = WAL;");

const db = drizzle({
  client,
  schema,
  casing: "snake_case",
  // logger: queryLogger,
});

const dbSchema = schema;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export { db, dbSchema, type DbTransaction };
