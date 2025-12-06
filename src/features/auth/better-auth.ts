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
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  baseURL: process.env.APP_BASE_URL,
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
