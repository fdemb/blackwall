import { setBetterAuthCookie } from "@/server/shared/utils.server";
import { createServerFn } from "@tanstack/solid-start";
import { getRequestHeaders } from "@tanstack/solid-start-server";
import * as z from "zod";
import {
  getAuthSession,
  getPreferredTheme as getPreferredThemeData,
  signInEmail as signInEmailData,
  signOut as signOutData,
  signUpEmail as signUpEmailData,
  updatePreferredTheme as updatePreferredThemeData,
} from "./data";
import { authMiddleware } from "./middleware/auth.middleware";
import { maybeAuthMiddleware } from "./middleware/maybe-auth.middleware";

export const signInEmail = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      email: z.email(),
      password: z.string().min(8).max(100),
    }),
  )
  .handler(async ({ data }) => {
    const { headers } = await signInEmailData(data);
    setBetterAuthCookie(headers.get("set-cookie"));
  });

export const signUpEmail = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      account: z.object({
        email: z.email(),
        password: z.string().min(8).max(100),
        name: z.string().min(2).max(100),
      }),
      workspace: z.object({
        displayName: z.string().min(3).max(64),
        slug: z.string().min(3).max(64),
      }),
    }),
  )
  .handler(async ({ data }) => {
    const { headers } = await signUpEmailData(data);
    setBetterAuthCookie(headers.get("set-cookie"));
  });

export const session = createServerFn({ method: "GET" }).handler(async () => {
  const result = await getAuthSession(getRequestHeaders());

  if (!result) {
    return null;
  }

  return {
    user: result.drizzleUser,
    session: result.session,
  };
});

export const logOut = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    await signOutData(getRequestHeaders());
  });

export const updatePreferredTheme = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ theme: z.enum(["system", "light", "dark"]) }))
  .handler(async ({ data, context }) => {
    await updatePreferredThemeData(data.theme, context.user.id);
  });

export const getPreferredTheme = createServerFn({ method: "GET" })
  .middleware([maybeAuthMiddleware])
  .handler(async ({ context }) => {
    try {
      return await getPreferredThemeData(context?.user);
    } catch (error) {
      return "system";
    }
  });
