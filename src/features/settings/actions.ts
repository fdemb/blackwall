import { AppError } from "@/features/shared/errors";
import { deleteFile, saveFile } from "@/lib/file-upload";
import { createServerFn } from "@tanstack/solid-start";
import { getRequestHeaders } from "@tanstack/solid-start-server";
import * as z from "zod";
import { authMiddleware } from "../auth/middleware/auth.middleware";
import { TeamMutations } from "../teams/dal/mutations";
import { WorkspaceQueries } from "../workspaces/dal/queries";
import { SettingsMutations } from "./dal/mutations";
import { SettingsQueries } from "./dal/queries";

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
    await WorkspaceQueries.getBySlug(data.workspaceSlug);

    return await TeamMutations.create({
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

    const updatedUser = await SettingsMutations.updateName({
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
    const currentUser = await SettingsQueries.getUserById(context.user.id);

    if (data.intent === "remove") {
      deleteFile(currentUser.image);
      return await SettingsMutations.updateAvatar({
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

    return await SettingsMutations.updateAvatar({
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
    await SettingsMutations.changePassword({
      headers: getRequestHeaders(),
      currentPassword: data.currentPassword,
      newPassword: data.newPassword,
      revokeOtherSessions: data.revokeOtherSessions,
    });
  });
