import {
  SettingsPage,
  SettingsSection,
} from "@/features/settings/components/settings-sections";
import { TeamAvatar } from "@/features/shared/components/custom-ui/avatar";
import { buttonVariants } from "@/features/shared/components/ui/button";
import { listTeams } from "@/features/teams/actions";
import { formatDateShort } from "@/lib/dates";
import { queryOptions } from "@tanstack/solid-query";
import { createFileRoute, Link } from "@tanstack/solid-router";
import { Index } from "solid-js";

const listTeamsQueryOptions = (workspaceSlug: string) =>
  queryOptions({
    queryKey: ["teams", "list", workspaceSlug],
    queryFn: () =>
      listTeams({
        data: { workspaceSlug },
      }),
  });

export const Route = createFileRoute("/_authorized/$workspace/settings/teams/")(
  {
    component: RouteComponent,
    loader: async ({ context, params }) => {
      const teamsData = await context.queryClient.ensureQueryData(
        listTeamsQueryOptions(params.workspace),
      );

      return {
        teamsData,
      };
    },
  },
);

function RouteComponent() {
  const params = Route.useParams();

  return (
    <SettingsPage title="Team management" fullWidth>
      <SettingsSection
        title="Teams"
        rightContent={
          <Link
            class={buttonVariants({ variant: "default", size: "sm" })}
            to="/$workspace/settings/teams/create"
            params={{
              workspace: params().workspace,
            }}
          >
            Create team
          </Link>
        }
      >
        <TeamTable />
      </SettingsSection>
    </SettingsPage>
  );
}

function TeamTable() {
  const params = Route.useParams();
  const data = Route.useLoaderData();

  return (
    <table>
      <thead>
        <tr class="border-y">
          <th class="text-left px-3 py-2 text-sm font-normal first:pl-6">
            Name
          </th>
          <th class="text-left px-3 py-2 text-sm font-normal first:pl-6">
            Key
          </th>
          <th class="text-left px-3 py-2 text-sm font-normal first:pl-6">
            Members
          </th>
          <th class="text-left px-3 py-2 text-sm font-normal first:pl-6">
            Issues
          </th>
          <th class="text-left px-3 py-2 text-sm font-normal first:pl-6">
            Created
          </th>
        </tr>
      </thead>

      <tbody>
        <Index each={data().teamsData}>
          {(team) => (
            <tr class="border-b relative hover:bg-muted">
              <td class="text-left px-3 py-3 text-sm first:pl-6">
                <Link
                  to="/$workspace/settings/teams/$key"
                  class="flex items-center gap-2 font-medium absolute inset-0"
                  params={{
                    workspace: params().workspace,
                    key: team().team.key,
                  }}
                />

                <div class="flex items-center gap-2 font-medium">
                  <TeamAvatar team={team().team} size="5" />
                  {team().team.name}
                </div>
              </td>
              <td class="text-left px-3 py-3 text-sm first:pl-6">
                {team().team.key}
              </td>
              <td class="text-left px-3 py-3 text-sm first:pl-6">
                {team().usersCount}
              </td>
              <td class="text-left px-3 py-3 text-sm first:pl-6">
                {team().issuesCount}
              </td>
              <td class="text-left px-3 py-3 text-sm first:pl-6">
                {formatDateShort(team().team.createdAt)}
              </td>
            </tr>
          )}
        </Index>
      </tbody>
    </table>
  );
}
