import type { User } from "@/db/schema";
import { auth } from "@/features/auth/better-auth";
import { SettingsQueries } from "./queries";

type UpdateNameInput = {
  userId: string;
  name: string;
  headers: Headers;
};

type UpdateAvatarInput = {
  userId: string;
  image: string | null;
  headers: Headers;
};

type ChangePasswordInput = {
  headers: Headers;
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
};

export const SettingsMutations = {
  updateName: async (input: UpdateNameInput): Promise<User> => {
    await auth.api.updateUser({
      headers: input.headers,
      body: {
        name: input.name,
      },
    });

    return await SettingsQueries.getUserById(input.userId);
  },

  updateAvatar: async (input: UpdateAvatarInput): Promise<User> => {
    await auth.api.updateUser({
      headers: input.headers,
      body: {
        image: input.image ?? "",
      },
    });

    return await SettingsQueries.getUserById(input.userId);
  },

  changePassword: async (input: ChangePasswordInput): Promise<void> => {
    await auth.api.changePassword({
      headers: input.headers,
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: input.revokeOtherSessions ?? false,
      },
    });
  },
};
