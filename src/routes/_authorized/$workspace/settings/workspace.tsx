import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-sections";
import { toast } from "@/features/shared/components/custom-ui/toast";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { useWorkspaceData } from "@/features/shared/context/workspace-context";
import { updateWorkspaceName } from "@/features/workspaces/actions";
import { useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import * as z from "zod";

export const Route = createFileRoute(
  "/_authorized/$workspace/settings/workspace",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const workspaceData = useWorkspaceData();
  const ids = {
    displayName: {
      field: "workspace-display-name",
      description: "workspace-display-name-description",
    },
  } as const;

  return (
    <SettingsPage title="Workspace settings">
      <SettingsSection title="Details">
        <SettingsCard>
          <SettingsRow
            title="Workspace name"
            description="This is visible to all members of the workspace."
            htmlFor={ids.displayName.field}
            descriptionId={ids.displayName.description}
          >
            <WorkspaceNameForm
              defaultName={workspaceData().workspace.displayName}
              workspaceId={workspaceData().workspace.id}
              inputId={ids.displayName.field}
              descriptionId={ids.displayName.description}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

type WorkspaceNameFormProps = {
  defaultName: string;
  workspaceId: string;
  inputId: string;
  descriptionId: string;
};

function WorkspaceNameForm(props: WorkspaceNameFormProps) {
  const queryClient = useQueryClient();
  const updateName = useServerFn(updateWorkspaceName);
  const form = useAppForm(() => ({
    defaultValues: {
      name: props.defaultName,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .min(1, "Workspace name is required")
          .max(100, "Workspace name must be shorter than 100 characters"),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        const updated = await updateName({
          data: {
            workspaceId: props.workspaceId,
            displayName: value.name,
          },
        });
        toast.success("Workspace name updated successfully.");
        form.reset({ name: updated.displayName });
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
            label="Workspace name"
            placeholder="e.g. Acme Inc"
            labelClass="sr-only"
            onBlur={submitOnBlur}
          />
        )}
      </form.AppField>
    </form>
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
