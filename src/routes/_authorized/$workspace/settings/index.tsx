import { createFileRoute, redirect } from "@tanstack/solid-router";

export const Route = createFileRoute("/_authorized/$workspace/settings/")({
  loader(ctx) {
    throw redirect({
      to: "/$workspace/settings/general",
      params: {
        workspace: ctx.params.workspace,
      },
    });
  },
});
