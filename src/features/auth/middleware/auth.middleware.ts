import { createMiddleware } from "@tanstack/solid-start";
import { getRequest } from "@tanstack/start-server-core";
import { redirect } from "@tanstack/solid-router";

import { AuthQueries } from "../dal/queries";

export const authMiddleware = createMiddleware()
  .server(async ({ next }) => {
    const request = getRequest();
    const result = await AuthQueries.getSession(request.headers);

    if (!result) {
      throw redirect({
        to: "/signin",
        search: {
          reason: "unauthorized",
        }
      })
    }

    return next({
      context: {
        session: result.session,
        user: result.drizzleUser,
        betterAuthUser: result.user,
      },
    });
  });
