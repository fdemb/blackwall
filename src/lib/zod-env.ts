import * as z from "zod";

export const envSchema = z.object({
  APP_BASE_URL: z.url(),
  APP_SECRET: z.string(),

  DATABASE_URL: z.string(),
  QUEUE_DATABASE_URL: z.string(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z
    .string()
    .optional()
    .default("Blackwall <noreply@blackwall.dev>"),
});

const env_internal = envSchema.safeParse(process.env);

if (!env_internal.success) {
  console.error("Invalid environment variables");
  console.error(z.treeifyError(env_internal.error));
  process.exit(1);
}

export const env = env_internal.data;
