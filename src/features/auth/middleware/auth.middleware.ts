import { createMiddleware } from "@tanstack/solid-start";
import { AuthQueries } from "../dal/queries";

export const authMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const result = await AuthQueries.getSession(request.headers);

    if (!result) {
      // setResponseStatus(401);
      throw new Error("UNAUTHORIZED");
    }

    return next({
      context: {
        session: result.session,
        user: result.drizzleUser,
        betterAuthUser: result.user,
      },
    });
  },
);
