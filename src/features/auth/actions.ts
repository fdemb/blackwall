import { createServerFn } from "@tanstack/solid-start";
import { getRequestHeaders } from "@tanstack/solid-start-server";
import * as z from "zod";
import { setBetterAuthCookie } from "../shared/utils.server";
import { AuthMutations } from "./dal/mutations";
import { AuthQueries } from "./dal/queries";
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
    const { headers } = await AuthMutations.signInEmail(data);
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
    const { headers } = await AuthMutations.signUpEmail(data);
    setBetterAuthCookie(headers.get("set-cookie"));
  });

export const session = createServerFn({ method: "GET" }).handler(async () => {
  const result = await AuthQueries.getSession(getRequestHeaders());

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
    await AuthMutations.signOut(getRequestHeaders());
  });

export const updatePreferredTheme = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ theme: z.enum(["system", "light", "dark"]) }))
  .handler(async ({ data, context }) => {
    await AuthMutations.updatePreferredTheme(data.theme, context.user.id);
  });

export const getPreferredTheme = createServerFn({ method: "GET" })
  .middleware([maybeAuthMiddleware])
  .handler(async ({ context }) => {
    return await AuthQueries.getPreferredTheme(context?.user);
  });
