import {
  SettingsBackButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-sections";
import { Button } from "@/features/shared/components/ui/button";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { createTeam } from "@/features/settings/actions";
import { useQueryClient } from "@tanstack/solid-query";
import { createFileRoute, useRouter } from "@tanstack/solid-router";
import * as z from "zod";

export const Route = createFileRoute(
  "/_authorized/$workspace/settings/teams/create",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const params = Route.useParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const form = useAppForm(() => ({
    defaultValues: {
      name: "",
      key: "",
    },
    validators: {
      onSubmit: z.object({
        name: z.string().min(1, "Name is required"),
        key: z
          .string()
          .min(1, "Key is required")
          .max(5, "Key must be at most 5 characters"),
      }),
    },
    onSubmit: async ({ value }) => {
      await createTeam({
        data: {
          ...value,
          workspaceSlug: params().workspace,
        },
      });

      queryClient.invalidateQueries();
    },
  }));
  return (
    <>
      <SettingsBackButton
        to="/$workspace/settings/teams"
        params={{ workspace: params().workspace }}
      >
        Back to team management
      </SettingsBackButton>

      <SettingsPage title="Create a team">
        <SettingsSection>
          <form
            class="w-full flex flex-col"
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
                      rootClass="items-end"
                    />
                  )}
                </form.AppField>
              </SettingsRow>

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
                      rootClass="items-end"
                    />
                  )}
                </form.AppField>
              </SettingsRow>
            </SettingsCard>

            <div class="ml-auto pt-4">
              <form.Subscribe>
                {(state) => (
                  <Button type="submit" size="sm" disabled={!state().canSubmit}>
                    Create team
                  </Button>
                )}
              </form.Subscribe>
            </div>
          </form>
        </SettingsSection>
      </SettingsPage>
    </>
  );
}
