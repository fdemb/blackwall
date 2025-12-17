import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { action } from "@/lib/form.utils";
import { inviteUser } from "@/server/inviting/api";
import { useDialogContext } from "@kobalte/core/dialog";
import * as z from "zod";
import { useAppForm } from "../../context/form-context";
import { useWorkspaceData } from "../../context/workspace-context";
import { Button } from "../ui/button";
import { TanStackTextField } from "../ui/text-field";

export function InviteDialogContent() {
  const workspaceData = useWorkspaceData();
  const ctx = useDialogContext();
  const form = useAppForm(() => ({
    defaultValues: {
      email: "",
    },
    validators: {
      onSubmit: z.object({
        email: z.email().min(1, "Email is required"),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await action(
        inviteUser({
          data: {
            workspaceSlug: workspaceData().workspace.slug,
            email: value.email,
          },
        }),
        formApi,
      );

      ctx.close();
    },
  }));

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Invite user</DialogTitle>
        <DialogDescription>
          Enter the email address of the user you want to invite.
        </DialogDescription>
      </DialogHeader>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <form.AppField name="email">
          {() => (
            <TanStackTextField
              id="email"
              describedBy="email-description"
              label="Email address"
              placeholder="john.doe@example.com"
            />
          )}
        </form.AppField>

        <DialogFooter class="mt-6">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              form.reset();
              ctx.close();
            }}
          >
            Cancel
          </Button>
          <form.Subscribe>
            {(state) => (
              <Button type="submit" disabled={!state().canSubmit}>
                Invite
              </Button>
            )}
          </form.Subscribe>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
