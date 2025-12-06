import { AppError } from "@/features/shared/errors";
import { fetchInvitation } from "@/features/workspaces/actions";
import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createFileRoute } from "@tanstack/solid-router";

const fetchInvitationQueryOptions = (token: string) =>
  queryOptions({
    queryKey: ["invitation", "fetch", token],
    queryFn: async () => {
      try {
        return await fetchInvitation({
          data: {
            token,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          throw new Error(error.message);
        }
        throw error;
      }
    },
  });

export const Route = createFileRoute("/_either/invite/$token")({
  component: RouteComponent,
  loader: async ({ params, context }) => {
    try {
      return await context.queryClient.ensureQueryData(
        fetchInvitationQueryOptions(params.token),
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw new Error(error.message);
      }
      throw error;
    }
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const invitationQuery = useQuery(() =>
    fetchInvitationQueryOptions(params().token),
  );

  const data = () => invitationQuery.data;

  return (
    <div>
      <pre>{JSON.stringify(data(), null, 2)}</pre>
    </div>
  );
}
