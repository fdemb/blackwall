import { Database } from "bun:sqlite";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");

const client = new Database(process.env.DATABASE_URL);

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
