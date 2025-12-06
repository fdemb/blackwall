import {
  changePassword,
  updateProfileAvatar,
  updateProfileName,
} from "@/features/settings/actions";
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-sections";
import { UserAvatar } from "@/features/shared/components/custom-ui/avatar";
import { toast } from "@/features/shared/components/custom-ui/toast";
import { Button } from "@/features/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/features/shared/components/ui/dialog";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { useSessionData } from "@/features/shared/context/session-context";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import Trash2 from "lucide-solid/icons/trash-2";
import { createSignal, Show } from "solid-js";
import * as z from "zod";

export const Route = createFileRoute(
  "/_authorized/$workspace/settings/profile",
)({
  component: RouteComponent,
});

const MAX_AVATAR_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function RouteComponent() {
  const session = useSessionData();
  const ids = {
    displayName: {
      field: "profile-display-name",
      description: "profile-display-name-description",
    },
  } as const;

  return (
    <SettingsPage title="Profile">
      <SettingsSection title="Account">
        <SettingsCard>
          <SettingsRow
            title="Display name"
            description="This is visible to everyone in your workspaces."
            htmlFor={ids.displayName.field}
            descriptionId={ids.displayName.description}
          >
            <DisplayNameForm
              defaultName={session().user.name}
              inputId={ids.displayName.field}
              descriptionId={ids.displayName.description}
            />
          </SettingsRow>

          <SettingsRow
            title="Avatar"
            description="Used across comments, mentions, and anywhere your profile appears."
          >
            <AvatarUpload />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Security">
        <SettingsCard>
          <SettingsRow
            title="Password"
            description="Change your password to keep your account secure."
          >
            <PasswordChangeDialog />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

type DisplayNameFormProps = {
  defaultName: string;
  inputId: string;
  descriptionId: string;
};

function DisplayNameForm(props: DisplayNameFormProps) {
  const queryClient = useQueryClient();
  const updateName = useServerFn(updateProfileName);
  const form = useAppForm(() => ({
    defaultValues: {
      name: props.defaultName,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .min(2, "Name must be at least 2 characters long")
          .max(100, "Name must be shorter than 100 characters"),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        const updated = await updateName({
          data: { name: value.name },
        });
        toast.success("Name updated successfully.");
        form.reset({ name: updated.name });
        queryClient.invalidateQueries();
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
  }));

  const submitOnBlur = () => {
    queueMicrotask(() => {
      const state = form.state;
      if (state.canSubmit && state.isDirty && !state.isSubmitting) {
        form.handleSubmit();
      }
    });
  };

  return (
    <form
      class="contents"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.AppField name="name">
        {() => (
          <TanStackTextField
            id={props.inputId}
            describedBy={props.descriptionId}
            label="Display name"
            placeholder="e.g. Ada Lovelace"
            autocomplete="name"
            labelClass="sr-only"
            onBlur={submitOnBlur}
          />
        )}
      </form.AppField>
    </form>
  );
}

function AvatarUpload() {
  const session = useSessionData();
  const queryClient = useQueryClient();
  const updateAvatar = useServerFn(updateProfileAvatar);
  let fileInputRef: HTMLInputElement | undefined;

  const validateFile = (file: File): string | null => {
    if (!file.type.startsWith("image/")) {
      return "Only image files are supported.";
    }
    if (file.size > MAX_AVATAR_FILE_SIZE) {
      return "Image must be smaller than 5MB.";
    }
    return null;
  };

  const handleFileUpload = async (file: File | undefined | null) => {
    if (!file) return;

    const validationError = validateFile(file);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const formData = new FormData();
    formData.append("intent", "upload-file");
    formData.append("file", file);

    try {
      await updateAvatar({ data: formData });
      toast.success("Avatar updated.");
      queryClient.invalidateQueries();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      if (fileInputRef) {
        fileInputRef.value = "";
      }
    }
  };

  const handleRemove = async () => {
    const formData = new FormData();
    formData.append("intent", "remove");

    try {
      await updateAvatar({ data: formData });
      toast.success("Avatar removed.");
      queryClient.invalidateQueries();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <div class="flex items-center gap-3">
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        class="hidden"
        id="avatar-upload"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          void handleFileUpload(file);
        }}
      />
      <label
        for="avatar-upload"
        class={cn(
          "relative cursor-pointer rounded-full",
          "ring-offset-background transition-all",
          "hover:ring-2 hover:ring-ring hover:ring-offset-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
        tabindex="0"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef?.click();
          }
        }}
      >
        <UserAvatar user={session().user} size="lg" class="shadow-sm" />
      </label>
      <Show when={session().user.image}>
        <Button
          type="button"
          variant="ghost"
          size="iconSm"
          onClick={() => void handleRemove()}
          aria-label="Remove avatar"
        >
          <Trash2 class="size-4" />
        </Button>
      </Show>
    </div>
  );
}

function PasswordChangeDialog() {
  const [isOpen, setIsOpen] = createSignal(false);
  const updatePassword = useServerFn(changePassword);
  const form = useAppForm(() => ({
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
    validators: {
      onSubmit: z
        .object({
          currentPassword: z.string().min(8, "Enter your current password"),
          newPassword: z
            .string()
            .min(8, "New password must be at least 8 characters"),
          confirmPassword: z.string().min(8, "Confirm your new password"),
        })
        .refine((values) => values.newPassword === values.confirmPassword, {
          message: "Passwords do not match",
          path: ["confirmPassword"],
        }),
    },
    onSubmit: async ({ value }) => {
      try {
        await updatePassword({
          data: {
            currentPassword: value.currentPassword,
            newPassword: value.newPassword,
          },
        });
        toast.success("Password updated.");
        form.reset();
        setIsOpen(false);
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
  }));

  return (
    <Dialog open={isOpen()} onOpenChange={setIsOpen}>
      <DialogTrigger as={Button} variant="outline" size="sm">
        Change password
      </DialogTrigger>
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Enter your current password and choose a new one to update your
            account security.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          class="flex flex-col gap-4"
        >
          <form.AppField name="currentPassword">
            {() => (
              <TanStackTextField
                label="Current password"
                type="password"
                autocomplete="current-password"
                placeholder="Enter your current password"
              />
            )}
          </form.AppField>

          <form.AppField name="newPassword">
            {() => (
              <TanStackTextField
                label="New password"
                type="password"
                autocomplete="new-password"
                placeholder="Choose a strong password"
              />
            )}
          </form.AppField>

          <form.AppField name="confirmPassword">
            {() => (
              <TanStackTextField
                label="Confirm new password"
                type="password"
                autocomplete="new-password"
                placeholder="Repeat your new password"
              />
            )}
          </form.AppField>

          <DialogFooter>
            <form.Subscribe>
              {(state) => (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!state().canSubmit}>
                    Update password
                  </Button>
                </>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Something went wrong. Please try again.";
}
