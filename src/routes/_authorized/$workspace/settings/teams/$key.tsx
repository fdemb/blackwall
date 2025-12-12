import {
  SettingsBackButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-sections";
import { toast } from "@/features/shared/components/custom-ui/toast";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import {
  getFullTeam,
  updateTeamKey,
  updateTeamName,
} from "@/features/teams/actions";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/solid-query";
import {
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import * as z from "zod";

const getTeamQueryOptions = (workspaceSlug: string, teamKey: string) =>
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
          <NameForm defaultName={teamQuery.data.name} />
          <KeyForm defaultKey={teamQuery.data.key} />
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
  const router = useRouter();

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
        router.invalidate();
        queryClient.refetchQueries();
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
      <SettingsCard>
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
      </SettingsCard>
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
  const router = useRouter();

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
        router.invalidate();
        queryClient.refetchQueries();

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
      <SettingsCard>
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
      </SettingsCard>
    </form>
  );
}
