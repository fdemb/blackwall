import {
  fetchInvitation,
  registerAndAcceptInvitation,
} from "@/features/inviting/actions";
import { AuthCard } from "@/features/shared/components/blocks/auth";
import { Button } from "@/features/shared/components/ui/button";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { AppError } from "@/features/shared/errors";
import { action } from "@/lib/form.utils";
import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import * as z from "zod";

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
    return await context.queryClient.ensureQueryData(
      fetchInvitationQueryOptions(params.token),
    );
  },
});

function RouteComponent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const invitationQuery = useQuery(() =>
    fetchInvitationQueryOptions(params().token),
  );

  const form = useAppForm(() => ({
    defaultValues: {
      name: "",
      password: "",
    },
    validators: {
      onSubmit: z.object({
        name: z.string().min(2, "Name is required"),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await action(
        registerAndAcceptInvitation({
          data: {
            token: params().token,
            name: value.name,
            password: value.password,
          },
        }),
        formApi,
      );

      navigate({
        to: "/",
      });
    },
  }));

  if (!invitationQuery.data) {
    throw new Error("Invitation not found.");
  }

  return (
    <div>
      <AuthCard title={`Join ${invitationQuery.data.workspace.displayName}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
        >
          <div class="flex flex-col gap-6">
            <form.AppField name="name">
              {() => (
                <TanStackTextField
                  label="Name"
                  autofocus
                  placeholder="Enter your full name..."
                  inputClass="p-3 h-auto !text-base"
                />
              )}
            </form.AppField>

            <form.AppField name="password">
              {() => (
                <TanStackTextField
                  label="Password"
                  type="password"
                  placeholder="Your secure password..."
                  inputClass="p-3 h-auto !text-base"
                />
              )}
            </form.AppField>

            <form.Subscribe>
              {(state) => (
                <div class="flex flex-col gap-2">
                  <Button
                    type="submit"
                    size="lg"
                    class="text-base"
                    disabled={!state().canSubmit}
                  >
                    Join Workspace
                  </Button>
                </div>
              )}
            </form.Subscribe>
          </div>
        </form>
      </AuthCard>
    </div>
  );
}
