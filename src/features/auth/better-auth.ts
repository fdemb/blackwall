import { env } from "@/lib/zod-env";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../../db";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          }
        : undefined,
  },
  baseURL: env.APP_BASE_URL,
  secret: env.APP_SECRET,
  advanced: {
    database: {
      generateId: false,
    },
  },
  user: {
    additionalFields: {
      lastWorkspaceId: {
        type: "string",
        fieldName: "last_workspace_id",
        input: false,
      },
    },
  },
});
