import { createMiddleware } from "@tanstack/solid-start";
import { getAuthSession } from "../data";

export const maybeAuthMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    try {
      const result = await getAuthSession(request.headers);

      if (!result) {
        return next();
      }

      return next({
        context: {
          session: result.session,
          user: result.drizzleUser,
          betterAuthUser: result.user,
        },
      });
    } catch (error) {
      return next();
    }
  },
);
