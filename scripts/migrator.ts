import { env } from "@/lib/zod-env";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

if (Bun.argv.length !== 3) {
  throw new Error("Migration folder not provided");
}

const client = new Database(env.DATABASE_URL);
client.run("PRAGMA journal_mode = WAL;");

const db = drizzle({
  client,
  casing: "snake_case",
  logger: true,
});

migrate(db, {
  migrationsFolder: Bun.argv[2],
});

console.log("Migrations complete");
