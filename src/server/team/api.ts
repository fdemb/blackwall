import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { getTeamForUser, listTeamUsers } from "./data";

export const listUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return listTeamUsers({
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
    return getTeamForUser({
      user: context.user,
      ...data,
    });
  });
