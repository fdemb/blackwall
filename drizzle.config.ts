import { env } from "@/lib/zod-env";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: env.DATABASE_URL },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
