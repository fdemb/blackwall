import * as z from "zod";

export const envSchema = z.object({
  DATABASE_URL: z.string(),
  APP_BASE_URL: z.url(),
  APP_SECRET: z.string(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

const env_internal = envSchema.safeParse(process.env);

if (!env_internal.success) {
  console.error("Invalid environment variables");
  console.error(z.treeifyError(env_internal.error));
  process.exit(1);
}

export const env = env_internal.data;
