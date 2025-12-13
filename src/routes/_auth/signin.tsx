import { signInEmail } from "@/features/auth/actions";
import { useTheme } from "@/features/settings/hooks/use-theme";
import { AuthCard } from "@/features/shared/components/blocks/auth";
import { FastLink } from "@/features/shared/components/custom-ui/fast-link";
import { Button, buttonVariants } from "@/features/shared/components/ui/button";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { tryServerFn } from "@/lib/form.utils";
import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import * as z from "zod";

export const Route = createFileRoute("/_auth/signin")({
  component: RouteComponent,
});

function RouteComponent() {
  const handleSignInEmail = useServerFn(signInEmail);
  const navigate = useNavigate();
  const { setThemeToUserPreference } = useTheme();

  const form = useAppForm(() => ({
    defaultValues: {
      email: "",
      password: "",
    },
    validators: {
      onSubmit: z.object({
        email: z.email(),
        password: z.string().min(8),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await tryServerFn(
        handleSignInEmail({
          data: value,
        }),
        formApi,
      );

      setThemeToUserPreference();

      navigate({
        to: "/",
      });
    },
  }));

  return (
    <AuthCard title="Sign in">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <div class="flex flex-col gap-6">
          <form.AppField name="email">
            {() => (
              <TanStackTextField
                label="Email address"
                type="email"
                autofocus
                placeholder="Enter your email address..."
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
                  Sign In
                </Button>

                <FastLink
                  to="/signup"
                  class={buttonVariants({ variant: "link" })}
                >
                  Sign Up
                </FastLink>
              </div>
            )}
          </form.Subscribe>
        </div>
      </form>
    </AuthCard>
  );
}
