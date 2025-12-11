import { env } from "@/lib/zod-env";
import { Database } from "bun:sqlite";

const client = new Database(env.DATABASE_URL);

async function dropAll() {
  const tables = client
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];

  for (const table of tables) {
    client.run(`DROP TABLE IF EXISTS "${table.name}"`);
  }

  client.close();
}

dropAll().then(() => {
  console.log("Dropped all tables successfully.");
});
