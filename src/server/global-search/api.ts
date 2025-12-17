import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { createServerFn } from "@tanstack/solid-start";
import z from "zod";
import { getWorkspaceForUser } from "../workspace/data";
import { executeGlobalSearch } from "./data";

export const globalSearch = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      searchTerm: z.string(),
      workspaceSlug: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await getWorkspaceForUser({
      user: context.user,
      slug: data.workspaceSlug,
    });

    return await executeGlobalSearch({
      searchTerm: data.searchTerm,
      workspaceId: workspace.id,
      user: context.user,
    });
  });
