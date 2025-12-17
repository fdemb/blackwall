import { signUpEmail } from "@/features/auth/actions";
import { useTheme } from "@/features/settings/hooks/use-theme";
import { AuthCard } from "@/features/shared/components/blocks/auth";
import { FastLink } from "@/features/shared/components/custom-ui/fast-link";
import { Button, buttonVariants } from "@/features/shared/components/ui/button";
import { TanStackTextField } from "@/features/shared/components/ui/text-field";
import { useAppForm } from "@/features/shared/context/form-context";
import { action, validateFields } from "@/lib/form.utils";
import { createFileRoute, useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import { createSignal, Match, Switch } from "solid-js";
import * as z from "zod";

type SignUpFormApi = ReturnType<typeof useSignupForm>;

export const Route = createFileRoute("/_auth/signup")({
  component: RouteComponent,
});

const useSignupForm = () => {
  const handleSignUpEmail = useServerFn(signUpEmail);
  const navigate = useNavigate();
  const { setThemeToUserPreference } = useTheme();

  const form = useAppForm(() => ({
    defaultValues: {
      account: {
        name: "",
        email: "",
        password: "",
      },
      workspace: {
        displayName: "",
        slug: "",
      },
    },
    onSubmit: async ({ value, formApi }) => {
      await action(
        handleSignUpEmail({
          data: value,
        }),
        formApi,
      );

      setThemeToUserPreference();

      navigate({
        to: "/",
      });
    },
    validators: {
      onSubmit: z.object({
        account: z.object({
          name: z.string().min(2).max(100),
          email: z.email(),
          password: z.string().min(8),
        }),
        workspace: z.object({
          displayName: z.string().min(3).max(64),
          slug: z.string().min(3).max(64),
        }),
      }),
    },
  }));

  return form;
};

function RouteComponent() {
  const [step, setStep] = createSignal<"account" | "workspace">("account");
  const form = useSignupForm();

  return (
    <AuthCard title="Sign up">
      <Switch>
        <Match when={step() === "account"}>
          <AccountForm form={form} onContinue={() => setStep("workspace")} />
        </Match>
        <Match when={step() === "workspace"}>
          <WorkspaceForm
            form={form}
            onBack={() => setStep("account")}
            onContinue={() => form.handleSubmit()}
          />
        </Match>
      </Switch>
    </AuthCard>
  );
}

function AccountForm(props: { form: SignUpFormApi; onContinue: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();

        const errors = validateFields(props.form, [
          "account.email",
          "account.password",
          "account.name",
        ]);

        if (errors.length === 0) {
          props.onContinue();
        }
      }}
    >
      <div class="flex flex-col gap-6">
        <props.form.AppField name="account.email">
          {() => (
            <TanStackTextField
              label="Email address"
              inputClass="p-3 h-auto !text-base"
              type="email"
              placeholder="john.doe@example.com"
              autofocus
              autocomplete="email"
            />
          )}
        </props.form.AppField>

        <props.form.AppField name="account.password">
          {() => (
            <TanStackTextField
              label="Password"
              inputClass="p-3 h-auto !text-base"
              type="password"
              placeholder="Tip: use a password generator"
              autocomplete="new-password"
            />
          )}
        </props.form.AppField>

        <props.form.AppField name="account.name">
          {() => (
            <TanStackTextField
              label="Full Name"
              inputClass="p-3 h-auto !text-base"
              type="text"
              placeholder="John Doe"
              autocomplete="name"
            />
          )}
        </props.form.AppField>

        <div class="flex flex-col gap-2">
          <props.form.Subscribe>
            {(state) => (
              <Button
                type="submit"
                size="lg"
                class="text-base"
                disabled={!state().canSubmit || state().isSubmitting}
              >
                Continue
              </Button>
            )}
          </props.form.Subscribe>

          <FastLink to="/signin" class={buttonVariants({ variant: "link" })}>
            Back to login
          </FastLink>
        </div>
      </div>
    </form>
  );
}

function WorkspaceForm(props: {
  form: SignUpFormApi;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onContinue();
      }}
    >
      <div class="flex flex-col gap-6">
        <props.form.AppField name="workspace.displayName">
          {() => (
            <TanStackTextField
              label="Workspace Name"
              inputClass="p-3 w-72 h-auto !text-base"
              type="text"
              placeholder="Awesome workspace"
              autofocus
            />
          )}
        </props.form.AppField>

        <props.form.AppField name="workspace.slug">
          {() => (
            <TanStackTextField
              label="Workspace URL"
              inputClass="p-3 w-72 h-auto !text-base"
              type="text"
              placeholder="URL slug, e.g. awesome-workspace"
            />
          )}
        </props.form.AppField>

        <div class="flex flex-col gap-2">
          <Button type="submit" size="lg" class="text-base">
            Continue
          </Button>

          <Button type="button" variant="link" onClick={() => props.onBack()}>
            Back to account details
          </Button>
        </div>
      </div>
    </form>
  );
}
