import { db, dbSchema } from "@/db";
import { createServerFn } from "@tanstack/solid-start";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { IssueMutations } from "../issues/dal/issue-mutations";
import { AppError } from "../shared/errors";
import { WorkspaceQueries } from "../workspaces/dal/queries";
import { TeamMutations } from "./dal/mutations";
import { TeamQueries } from "./dal/queries";

export const createTeam = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      name: z.string().min(1, "Name is required"),
      key: z
        .string()
        .min(1, "Key is required")
        .max(5, "Key must be at most 5 characters"),
    }),
  )
  .handler(async ({ data, context }) => {
    const newTeam = await TeamMutations.create(data);

    await TeamMutations.addUser({
      user: context.user,
      team: newTeam,
    });

    return newTeam;
  });

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

export const listTeams = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await WorkspaceQueries.getForUser({
      user: context.user,
      slug: data.workspaceSlug,
    });

    return TeamQueries.listForUser({
      user: context.user,
      workspaceId: workspace.id,
    });
  });

export const getFullTeam = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return TeamQueries.getFullTeam({
      user: context.user,
      ...data,
    });
  });

export const updateTeamName = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
      name: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return TeamMutations.update({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      team: { name: data.name },
    });
  });

export const updateTeamKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
      newKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    await TeamMutations.update({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      team: { key: data.newKey },
    });

    const team = await TeamQueries.getForUser({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.newKey,
    });

    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.");
    }

    await IssueMutations.bulkChangeTeamKeys({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      team,
    });

    return team;
  });

export const listWorkspaceUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return TeamQueries.listWorkspaceUsers({
      user: context.user!,
      ...data,
    });
  });

export const addTeamMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
      userId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const team = await TeamQueries.getForUser({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
    });

    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.");
    }

    // Get the user to add
    const [userToAdd] = await db
      .select()
      .from(dbSchema.user)
      .where(eq(dbSchema.user.id, data.userId))
      .limit(1);

    if (!userToAdd) {
      throw new AppError("NOT_FOUND", "User not found.");
    }

    await TeamMutations.addUser({
      user: userToAdd,
      team,
    });

    return { success: true };
  });

export const removeTeamMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
      userId: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    await TeamMutations.removeUser({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      userId: data.userId,
    });

    return { success: true };
  });
