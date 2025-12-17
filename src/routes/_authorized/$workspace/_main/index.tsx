import { PageHeader } from "@/components/blocks/page-header";
import { list, uploadAttachment } from "@/server/issues/api";
import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createFileRoute, notFound } from "@tanstack/solid-router";

const listIssuesQueryOptions = (workspaceSlug: string) =>
  queryOptions({
    queryKey: ["issues", "list", workspaceSlug],
    queryFn: () =>
      list({
        data: {
          workspaceSlug,
        },
      }),
  });

export const Route = createFileRoute("/_authorized/$workspace/_main/")({
  component: RouteComponent,
  loader: async ({ params, context }) => {
    const issues = await context.queryClient.ensureQueryData(
      listIssuesQueryOptions(params.workspace),
    );

    if (!issues) {
      throw notFound();
    }

    return {
      issues,
    };
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const issuesQuery = useQuery(() =>
    listIssuesQueryOptions(params().workspace),
  );

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const target = e.target as HTMLFormElement;
    const formData = new FormData(target);
    console.log(formData);

    uploadAttachment({
      data: formData,
    });
  }

  return (
    <>
      <PageHeader>Dashboard</PageHeader>
      Here will be some dashboard
      <form enctype="multipart/form-data" method="post" onSubmit={handleSubmit}>
        <input type="file" name="file" />
        <button>Submit</button>
      </form>
    </>
  );
}
