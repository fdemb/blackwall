import { getPreferredTeam } from "@/server/team/api";
import { createFileRoute, notFound, redirect } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized/$workspace/_main/")({
  loader: async ({ params }) => {
    const preferredTeam = await getPreferredTeam({
      data: {
        workspaceSlug: params.workspace,
      },
    });

    if (!preferredTeam) {
      // TODO: show onboarding page
      throw notFound();
    }

    throw redirect({
      to: "/$workspace/team/$teamKey/issues",
      params: {
        workspace: params.workspace,
        teamKey: preferredTeam.key,
      },
    });
  },
});
