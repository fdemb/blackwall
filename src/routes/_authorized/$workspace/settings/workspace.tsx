import { InviteDialogContent } from "@/components/blocks/invite-dialog";
import { UserAvatar } from "@/components/custom-ui/avatar";
import { toast } from "@/components/custom-ui/toast";
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/settings-sections";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { TanStackTextField } from "@/components/ui/text-field";
import { useAppForm } from "@/context/form-context";
import { useSessionData } from "@/context/session-context";
import { useWorkspaceData } from "@/context/workspace-context";
import { listWorkspaceUsers, updateWorkspaceName } from "@/server/settings/api";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import { Index, Show } from "solid-js";
import * as z from "zod";

const getWorkspaceUsersQueryOptions = (workspaceSlug: string) =>
  queryOptions({
    queryKey: ["users", workspaceSlug],
    queryFn: () => {
      return listWorkspaceUsers({
        data: {
          workspaceSlug,
        },
      });
    },
  });

export const Route = createFileRoute(
  "/_authorized/$workspace/settings/workspace",
)({
  component: RouteComponent,
  loader: async ({ params, context }) => {
    const workspaceUsers = await context.queryClient.ensureQueryData(
      getWorkspaceUsersQueryOptions(params.workspace),
    );

    return {
      workspaceUsers,
    };
  },
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

      <SettingsSection title="Members">
        <MembersSection />
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

function MembersSection() {
  const params = Route.useParams();
  const session = useSessionData();

  const workspaceUsersQuery = useQuery(() =>
    getWorkspaceUsersQueryOptions(params().workspace),
  );
  const memberCount = () => workspaceUsersQuery.data?.length ?? 0;

  return (
    <SettingsCard variant="column">
      <div class="flex items-center justify-between px-4 pb-2">
        <p class="text-sm text-muted-foreground">
          {memberCount()} {memberCount() === 1 ? "member" : "members"}
        </p>

        <div class="flex items-center gap-2">
          <Dialog>
            <DialogTrigger as={Button} variant="outline" size="sm">
              Invite
            </DialogTrigger>
            <InviteDialogContent />
          </Dialog>
        </div>
      </div>

      <div class="flex flex-col divide-y divide-border">
        <Show
          when={memberCount() > 0}
          fallback={
            <div class="flex flex-col items-center justify-center py-8 text-center">
              <p class="text-sm text-muted-foreground">
                No members in this team yet.
              </p>
              <p class="text-xs text-muted-foreground mt-1">
                Add members to collaborate on issues.
              </p>
            </div>
          }
        >
          <Index each={workspaceUsersQuery.data ?? []}>
            {(member) => {
              const isCurrentUser = () => member().id === session().user.id;

              return (
                <div class="group flex items-center justify-between gap-4 px-4 py-3">
                  <div class="flex items-center gap-3 min-w-0">
                    <UserAvatar user={member()} size="sm" />
                    <div class="flex flex-col min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-medium truncate">
                          {member().name}
                        </span>
                        <Show when={isCurrentUser()}>
                          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                            You
                          </span>
                        </Show>
                      </div>
                      <Show when={member().email}>
                        <span class="text-xs text-muted-foreground truncate">
                          {member().email}
                        </span>
                      </Show>
                    </div>
                  </div>
                </div>
              );
            }}
          </Index>
        </Show>
      </div>
    </SettingsCard>
  );
}
