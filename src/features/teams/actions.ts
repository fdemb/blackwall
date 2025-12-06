import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { TeamQueries } from "./dal/queries";

export const listUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return TeamQueries.listUsers({
      user: context.user!,
      ...data,
    });
  });

export const getTeam = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return TeamQueries.getForUser({
      user: context.user,
      ...data,
    });
  });
