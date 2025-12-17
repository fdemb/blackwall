import { UserAvatar } from "@/components/custom-ui/avatar";
import type { PickerOption } from "@/components/custom-ui/picker";
import { PickerPopover } from "@/components/custom-ui/picker-popover";
import { toast } from "@/components/custom-ui/toast";
import {
  SettingsBackButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/settings-sections";
import { Button } from "@/components/ui/button";
import { TanStackTextField } from "@/components/ui/text-field";
import { useAppForm } from "@/context/form-context";
import { useSessionData } from "@/context/session-context";
import {
  addTeamMember,
  getFullTeam,
  listTeamUsers,
  listTeamWorkspaceUsers,
  removeTeamMember,
  updateTeamKey,
  updateTeamName,
} from "@/server/settings/api";
import { Popover } from "@kobalte/core/popover";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  createFileRoute,
  notFound,
  Outlet,
  useNavigate,
} from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import PlusIcon from "lucide-solid/icons/plus";
import XIcon from "lucide-solid/icons/x";
import { createMemo, createSignal, Index, Show } from "solid-js";
import * as z from "zod";

export const getTeamQueryOptions = (workspaceSlug: string, teamKey: string) =>
  queryOptions({
    queryKey: ["team", "get", workspaceSlug, teamKey],
    queryFn: () =>
      getFullTeam({
        data: {
          workspaceSlug,
          teamKey,
        },
      }),
  });

const getTeamMembersQueryOptions = (workspaceSlug: string, teamKey: string) =>
  queryOptions({
    queryKey: ["team", "members", workspaceSlug, teamKey],
    queryFn: () =>
      listTeamUsers({
        data: {
          workspaceSlug,
          teamKey,
        },
      }),
  });

export const Route = createFileRoute(
  "/_authorized/$workspace/settings/teams/$key",
)({
  component: RouteComponent,
  loader: async ({ params, context }) => {
    const team = await context.queryClient.ensureQueryData(
      getTeamQueryOptions(params.workspace, params.key),
    );

    if (!team) {
      throw notFound();
    }

    return {
      team,
    };
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const teamQuery = useQuery(() =>
    getTeamQueryOptions(params().workspace, params().key),
  );

  if (!teamQuery.data) {
    throw notFound();
  }

  return (
    <>
      <SettingsBackButton
        to="/$workspace/settings/teams"
        params={{ workspace: params().workspace }}
      >
        Back to team management
      </SettingsBackButton>
      <SettingsPage title={teamQuery.data.name}>
        <SettingsSection>
          <SettingsCard>
            <NameForm defaultName={teamQuery.data.name} />
            <KeyForm defaultKey={teamQuery.data.key} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Members">
          <MembersSection />
        </SettingsSection>
      </SettingsPage>
    </>
  );
}

type NameFormProps = {
  defaultName: string;
};

function NameForm(props: NameFormProps) {
  const params = Route.useParams();
  const updateTeamNameFn = useServerFn(updateTeamName);
  const queryClient = useQueryClient();

  const form = useAppForm(() => ({
    defaultValues: {
      name: props.defaultName,
    },
    validators: {
      onSubmit: z.object({
        name: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        await updateTeamNameFn({
          data: {
            workspaceSlug: params().workspace,
            teamKey: params().key,
            name: value.name,
          },
        });

        toast.success("Team name updated successfully.");
        queryClient.invalidateQueries();
      } catch (error) {
        toast.error("Failed to update team name.");
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
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <SettingsRow title="Name" description="The name of the team.">
        <form.AppField name="name">
          {() => (
            <TanStackTextField
              id="name"
              describedBy="name-description"
              label="Name"
              placeholder="e.g. Awesome Team"
              autocomplete="name"
              labelClass="sr-only"
              onBlur={submitOnBlur}
            />
          )}
        </form.AppField>
      </SettingsRow>
    </form>
  );
}

type KeyFormProps = {
  defaultKey: string;
};

function KeyForm(props: KeyFormProps) {
  const params = Route.useParams();
  const navigate = useNavigate();
  const updateTeamKeyFn = useServerFn(updateTeamKey);
  const queryClient = useQueryClient();

  const form = useAppForm(() => ({
    defaultValues: {
      key: props.defaultKey,
    },
    validators: {
      onSubmit: z.object({
        key: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        await updateTeamKeyFn({
          data: {
            workspaceSlug: params().workspace,
            teamKey: params().key,
            newKey: value.key,
          },
        });

        toast.success(
          "Team key updated successfully, issues will be updated shortly.",
        );
        queryClient.invalidateQueries();

        if (value.key !== props.defaultKey) {
          navigate({
            to: "/$workspace/settings/teams/$key",
            params: { workspace: params().workspace, key: value.key },
          });
        }
      } catch (error) {
        toast.error("Failed to update team key.");
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
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <SettingsRow
        title="Key"
        description="Used to identify the team issues were created in."
      >
        <form.AppField name="key">
          {() => (
            <TanStackTextField
              id="key"
              describedBy="key-description"
              label="Key"
              placeholder="e.g. AWSM"
              autocomplete="key"
              labelClass="sr-only"
              onBlur={submitOnBlur}
            />
          )}
        </form.AppField>
      </SettingsRow>
    </form>
  );
}

function MembersSection() {
  const params = Route.useParams();
  const session = useSessionData();
  const queryClient = useQueryClient();
  const [open, setOpen] = createSignal(false);

  const membersQuery = useQuery(() =>
    getTeamMembersQueryOptions(params().workspace, params().key),
  );

  const listWorkspaceUsersFn = useServerFn(listTeamWorkspaceUsers);
  const addTeamMemberFn = useServerFn(addTeamMember);
  const removeTeamMemberFn = useServerFn(removeTeamMember);

  const workspaceUsersQuery = useQuery(() => ({
    queryKey: ["workspace-users", params().workspace, params().key],
    queryFn: () =>
      listWorkspaceUsersFn({
        data: {
          workspaceSlug: params().workspace,
          teamKey: params().key,
        },
      }),
    enabled: open(),
  }));

  const availableUsersOptions = createMemo((): PickerOption<string>[] => {
    if (workspaceUsersQuery.isLoading) {
      return [];
    }

    const users = workspaceUsersQuery.data ?? [];
    return users.map((user) => ({
      id: user.id,
      label: user.name,
      icon: () => <UserAvatar user={user} size="xs" />,
    }));
  });

  const handleAddMember = async (userId: string) => {
    try {
      await addTeamMemberFn({
        data: {
          workspaceSlug: params().workspace,
          teamKey: params().key,
          userId,
        },
      });

      toast.success("Member added successfully.");
      queryClient.invalidateQueries({
        queryKey: ["team", "members", params().workspace, params().key],
      });
      queryClient.invalidateQueries({
        queryKey: ["workspace-users", params().workspace, params().key],
      });
      setOpen(false);
    } catch (error) {
      toast.error("Failed to add member.");
    }
  };

  const handleRemoveMember = async (userId: string) => {
    try {
      await removeTeamMemberFn({
        data: {
          workspaceSlug: params().workspace,
          teamKey: params().key,
          userId,
        },
      });

      toast.success("Member removed successfully.");
      queryClient.invalidateQueries();
    } catch (error) {
      toast.error("Failed to remove member.");
    }
  };

  const memberCount = () => membersQuery.data?.length ?? 0;

  return (
    <SettingsCard variant="column">
      <Outlet />
      <div class="flex items-center justify-between px-4 pb-2">
        <p class="text-sm text-muted-foreground">
          {memberCount()} {memberCount() === 1 ? "member" : "members"}
        </p>

        <div class="flex items-center gap-2">
          <Popover
            open={open()}
            onOpenChange={setOpen}
            placement="bottom-end"
            gutter={8}
          >
            <Popover.Trigger
              as={Button}
              variant="outline"
              size="xs"
              scaleEffect={false}
            >
              <PlusIcon class="size-4" />
              Add member
            </Popover.Trigger>
            <PickerPopover
              value={undefined}
              onChange={(userId: string | null) => {
                if (userId) {
                  handleAddMember(userId);
                }
              }}
              options={availableUsersOptions()}
              loading={workspaceUsersQuery.isLoading}
              emptyText={
                availableUsersOptions().length === 0
                  ? "All workspace members are already in this team"
                  : undefined
              }
            />
          </Popover>
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
          <Index each={membersQuery.data ?? []}>
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
                  <Show when={!isCurrentUser()}>
                    <Button
                      variant="ghost"
                      size="iconXs"
                      class="text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveMember(member().id)}
                      aria-label={`Remove ${member().name} from team`}
                    >
                      <XIcon class="size-4" />
                    </Button>
                  </Show>
                </div>
              );
            }}
          </Index>
        </Show>
      </div>
    </SettingsCard>
  );
}
