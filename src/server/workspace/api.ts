import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import { notFound } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import {
  addUserToTeam,
  createTeamBasedOnWorkspace,
  listTeamsForUser,
} from "../team/data";
import {
  createWorkspaceAndAddUser,
  getPreferredWorkspaceForUser,
  getWorkspaceForUser,
  listWorkspacesForUser,
  saveLastWorkspaceForUser,
} from "./data";

export const getWorkspaceAndGlobalData = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.string().min(1, "Workspace slug is required"))
  .handler(async ({ data, context }) => {
    const workspace = await getWorkspaceForUser({
      user: context.user,
      slug: data,
    });

    if (workspace) {
      await saveLastWorkspaceForUser({
        user: context.user,
        workspaceId: workspace.id,
      });
    }

    const teamsData = await listTeamsForUser({
      user: context.user,
      workspaceId: workspace.id,
    });

    return {
      workspace,
      teamsData,
    };
  });

export const createWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      slug: z.string().min(1, "Workspace slug is required"),
      displayName: z.string().min(1, "Workspace display name is required"),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await createWorkspaceAndAddUser({
      input: data,
      userId: context.user.id,
    });

    const team = await createTeamBasedOnWorkspace(workspace);
    await addUserToTeam({
      team,
      user: context.user,
    });

    return {
      workspace,
      team,
    };
  });

export const listUserWorkspaces = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return await listWorkspacesForUser(context.user);
  });

export const getPreferredWorkspace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const workspace = await getPreferredWorkspaceForUser(context.user!);

    if (!workspace) {
      throw notFound();
    }

    return workspace;
  });
