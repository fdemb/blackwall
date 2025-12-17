import { getPreferredWorkspace } from "@/server/workspace/api";
import { createFileRoute, redirect } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized/")({
  loader: async () => {
    const workspace = await getPreferredWorkspace();
    throw redirect({
      to: "/$workspace",
      params: {
        workspace: workspace.slug,
      },
    });
  },
});
