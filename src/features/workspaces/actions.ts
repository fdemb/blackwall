import { notFound } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import * as z from "zod";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { TeamMutations } from "../teams/dal/mutations";
import { TeamQueries } from "../teams/dal/queries";
import { WorkspaceMutations } from "./dal/mutations";
import { WorkspaceQueries } from "./dal/queries";

export const getWorkspaceAndGlobalData = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.string().min(1, "Workspace slug is required"))
  .handler(async ({ data, context }) => {
    const workspace = await WorkspaceQueries.getForUser({
      user: context.user,
      slug: data,
    });

    if (workspace) {
      await WorkspaceMutations.saveLastForUser({
        user: context.user,
        workspaceId: workspace.id,
      });
    }

    const teamsData = await TeamQueries.listForUser({
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
    const workspace = await WorkspaceMutations.createAndAddUser({
      input: data,
      userId: context.user.id,
    });

    const team = await TeamMutations.createBasedOnWorkspace(workspace);
    await TeamMutations.addUser({
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
    return await WorkspaceQueries.listForUser(context.user);
  });

export const getPreferredWorkspace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const workspace = await WorkspaceQueries.getPreferredForUser(context.user!);

    if (!workspace) {
      throw notFound();
    }

    return workspace;
  });

export const createInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceId: z.string().min(1, "Workspace ID is required"),
    }),
  )
  .handler(async ({ data, context }) => {
    const invitation = await WorkspaceMutations.createInvitation({
      user: context.user!,
      workspaceId: data.workspaceId,
    });

    return invitation;
  });

export const fetchInvitation = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      token: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const invitation = await WorkspaceQueries.fetchInvitationByToken(
      data.token,
    );

    return invitation;
  });
