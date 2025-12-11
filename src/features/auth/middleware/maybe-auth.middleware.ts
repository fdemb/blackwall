import { createMiddleware } from "@tanstack/solid-start";
import { AuthQueries } from "../dal/queries";

export const maybeAuthMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    try {
      const result = await AuthQueries.getSession(request.headers);

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
