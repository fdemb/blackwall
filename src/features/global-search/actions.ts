import { createServerFn } from "@tanstack/solid-start";
import z from "zod";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { WorkspaceQueries } from "../workspaces/dal/queries";
import { GlobalSearchQueries } from "./dal/queries";

export const globalSearch = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      searchTerm: z.string(),
      workspaceSlug: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await WorkspaceQueries.getForUser({
      user: context.user,
      slug: data.workspaceSlug,
    });

    return await GlobalSearchQueries.search({
      searchTerm: data.searchTerm,
      workspaceId: workspace.id,
      user: context.user,
    });
  });
