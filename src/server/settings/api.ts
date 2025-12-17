import { deleteFile, saveFile } from "@/lib/file-upload";
import { getUserById } from "@/server/auth/data";
import { authMiddleware } from "@/server/auth/middleware/auth.middleware";
import {
  changePassword as changePasswordData,
  updateAvatar,
  updateName,
} from "@/server/settings/data";
import { AppError } from "@/server/shared/errors";
import {
  addUserToTeam,
  createTeam as createTeamData,
  getTeamForUser,
  listRemainingTeamUsers,
  listTeamsForUser,
  listTeamUsers as listTeamUsersData,
  removeUserFromTeam,
  updateTeam,
} from "@/server/team/data";
import {
  getWorkspaceBySlug,
  getWorkspaceForUser,
  getWorkspaceForUserById,
  listWorkspaceUsers as listWorkspaceUsersData,
  updateWorkspaceDisplayName,
} from "@/server/workspace/data";
import { createServerFn } from "@tanstack/solid-start";
import { getRequestHeaders } from "@tanstack/solid-start-server";
import * as z from "zod";
import { bulkChangeIssueTeamKeys } from "../issues/issues";

export const createTeam = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string().min(1, "Workspace slug is required"),
      name: z.string().min(1, "Team name is required"),
      key: z.string().min(1, "Team key is required"),
    }),
  )
  .handler(async ({ data, context }) => {
    await getWorkspaceBySlug(data.workspaceSlug);

    return await createTeamData({
      workspaceSlug: data.workspaceSlug,
      key: data.key,
      name: data.name,
    });
  });

export const updateProfileName = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      name: z.string().min(2, "Name must be at least 2 characters").max(100),
    }),
  )
  .handler(async ({ data, context }) => {
    const normalizedName = data.name.trim();

    if (!normalizedName) {
      throw new AppError("BAD_REQUEST", "Name cannot be empty.");
    }

    const updatedUser = await updateName({
      headers: getRequestHeaders(),
      userId: context.user.id,
      name: normalizedName,
    });

    return updatedUser;
  });

type UpdateAvatarInput = {
  intent: "upload-file" | "remove";
  file?: File | null;
};

const MAX_AVATAR_FILE_SIZE = 5 * 1024 * 1024;

export const updateProfileAvatar = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator((input): UpdateAvatarInput => {
    if (!(input instanceof FormData)) {
      throw new AppError("BAD_REQUEST", "Invalid payload.");
    }

    const intentValue = (input.get("intent") ?? "upload-file") as string;
    const file = input.get("file");

    return {
      intent: (["upload-file", "remove"].includes(intentValue)
        ? intentValue
        : "upload-file") as UpdateAvatarInput["intent"],
      file: file instanceof File && file.size > 0 ? file : null,
    };
  })
  .handler(async ({ data, context }) => {
    const headers = getRequestHeaders();
    const currentUser = await getUserById(context.user.id);

    if (data.intent === "remove") {
      deleteFile(currentUser.image);
      return await updateAvatar({
        headers,
        userId: context.user.id,
        image: null,
      });
    }

    if (!data.file) {
      throw new AppError("BAD_REQUEST", "No avatar file provided.");
    }

    if (!data.file.type.startsWith("image/")) {
      throw new AppError("BAD_REQUEST", "Only image files are supported.");
    }

    if (data.file.size > MAX_AVATAR_FILE_SIZE) {
      throw new AppError("BAD_REQUEST", "Image must be smaller than 5MB.");
    }

    const avatarUrl = await saveFile(data.file, {
      directory: "avatars",
      prefix: context.user.id,
    });

    deleteFile(currentUser.image);

    return await updateAvatar({
      headers,
      userId: context.user.id,
      image: avatarUrl,
    });
  });

export const changePassword = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z
      .object({
        currentPassword: z.string().min(8, "Current password is required"),
        newPassword: z.string().min(8, "New password must be at least 8 chars"),
        revokeOtherSessions: z.boolean().optional(),
      })
      .refine((data) => data.currentPassword !== data.newPassword, {
        message: "New password must be different from the current password",
        path: ["newPassword"],
      }),
  )
  .handler(async ({ data }) => {
    await changePasswordData({
      headers: getRequestHeaders(),
      currentPassword: data.currentPassword,
      newPassword: data.newPassword,
      revokeOtherSessions: data.revokeOtherSessions,
    });
  });

export const listTeams = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string().min(1, "Workspace slug is required"),
    }),
  )
  .handler(async ({ data, context }) => {
    const workspace = await getWorkspaceForUser({
      user: context.user,
      slug: data.workspaceSlug,
    });

    return await listTeamsForUser({
      user: context.user,
      workspaceId: workspace.id,
    });
  });

// Workspace settings actions
export const updateWorkspaceName = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceId: z.string().min(1, "Workspace ID is required"),
      displayName: z.string().min(1, "Workspace name is required"),
    }),
  )
  .handler(async ({ data, context }) => {
    // Verify user has access to the workspace
    await getWorkspaceForUserById({
      user: context.user,
      workspaceId: data.workspaceId,
    });

    return await updateWorkspaceDisplayName({
      workspaceId: data.workspaceId,
      displayName: data.displayName,
    });
  });

export const listWorkspaceUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return await listWorkspaceUsersData({
      workspace: await getWorkspaceForUser({
        user: context.user,
        slug: data.workspaceSlug,
      }),
    });
  });

// Team settings actions
export const getFullTeam = createServerFn({ method: "GET" })
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

export const listTeamUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return listTeamUsersData({
      user: context.user!,
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
    return updateTeam({
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
    await updateTeam({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      team: { key: data.newKey },
    });

    const team = await getTeamForUser({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.newKey,
    });

    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.");
    }

    await bulkChangeIssueTeamKeys({
      user: context.user,
      workspaceSlug: data.workspaceSlug,
      team,
    });

    return team;
  });

export const listTeamWorkspaceUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      workspaceSlug: z.string(),
      teamKey: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    return listRemainingTeamUsers({
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
    const { db, dbSchema } = await import("@/db");
    const { eq } = await import("drizzle-orm");

    const team = await getTeamForUser({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
    });

    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.");
    }

    const [userToAdd] = await db
      .select()
      .from(dbSchema.user)
      .where(eq(dbSchema.user.id, data.userId))
      .limit(1);

    if (!userToAdd) {
      throw new AppError("NOT_FOUND", "User not found.");
    }

    await addUserToTeam({
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
    await removeUserFromTeam({
      user: context.user!,
      workspaceSlug: data.workspaceSlug,
      teamKey: data.teamKey,
      userId: data.userId,
    });

    return { success: true };
  });
