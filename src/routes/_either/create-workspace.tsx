import { AuthCard } from "@/features/shared/components/blocks/auth";
import { Button } from "@/features/shared/components/ui/button";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { createWorkspace } from "@/features/workspaces/actions";
import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";

export const Route = createFileRoute("/_either/create-workspace")({
  component: RouteComponent,
});

function RouteComponent() {
  const handleCreateWorkspace = useServerFn(createWorkspace);
  const navigate = useNavigate();

  const form = useAppForm(() => ({
    defaultValues: {
      displayName: "",
      slug: "",
    },
    onSubmit: async ({ value }) => {
      const { workspace } = await handleCreateWorkspace({
        data: value,
      });

      navigate({
        to: "/$workspace",
        params: { workspace: workspace.slug },
      });
    },
  }));

  return (
    <AuthCard>
      <form
        class="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <form.AppField name="displayName">
          {() => <TanStackTextField label="Name" />}
        </form.AppField>

        <form.AppField name="slug">
          {() => (
            <TanStackTextField
              label="URL"
              inputClass="pl-[170px]"
              beforeInput={
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
                  https://blackwallapp.com/
                </span>
              }
            />
          )}
        </form.AppField>

        <Button type="submit" class="w-full">
          Create Workspace
        </Button>
      </form>
    </AuthCard>
  );
}
