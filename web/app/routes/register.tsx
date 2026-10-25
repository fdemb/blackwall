import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Loader2, MailCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { auth, setCsrf, type AuthOptions } from "~/lib/api";
import { sameOriginPathOrHome } from "~/lib/auth-guard";
import { useI18n } from "~/lib/i18n";
import { invitationFromNext } from "~/lib/invitation";
import { useDocumentTitle } from "~/lib/title";
import { formText } from "~/lib/utils";
import type { Route } from "./+types/register";

export async function clientLoader(): Promise<AuthOptions> {
  return auth.options().catch(() => ({ registration: "open", email_verification: false }));
}

export default function Register({ loaderData }: Route.ComponentProps) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  useDocumentTitle(t("auth.register"));
  const linked = invitationFromNext(params.get("next"));
  const askInvitation = !linked && loaderData.registration === "invite";
  const signIn = { pathname: "/login", search: params.toString() };

  if (sentTo !== null)
    return (
      <>
        <MailCheck aria-hidden className="mb-3 size-7 text-primary" />
        <h1 className="text-balance text-3xl font-semibold tracking-tight">
          {t("auth.checkMail")}
        </h1>
        <p className="mb-6 mt-1 text-muted-foreground">{t("auth.verifySent", { email: sentTo })}</p>
        <Link to={signIn} className="font-medium text-primary hover:underline">
          {t("auth.backToLogin")}
        </Link>
      </>
    );

  return (
    <>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">
        {t("auth.createAccount")}
      </h1>
      <p className="mb-6 mt-1 text-muted-foreground">
        {askInvitation ? t("auth.inviteOnly") : t("auth.registerSub")}
      </p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const f = new FormData(e.currentTarget);
          const email = formText(f, "email");
          const invitation = askInvitation
            ? { workspace_id: formText(f, "workspace").trim(), token: formText(f, "token").trim() }
            : (linked ?? undefined);
          setBusy(true);
          setError("");
          try {
            const s = await auth.register(
              email,
              formText(f, "password"),
              formText(f, "name"),
              invitation,
            );
            if ("verification_sent" in s) {
              setSentTo(email);
              return;
            }
            setCsrf(s.csrf_token);
            // New accounts start in English. Keep the language the form was shown in.
            if (s.profile.language !== lang) {
              const { id: _id, email: _email, ...profile } = s.profile;
              await auth.editProfile({ ...profile, language: lang }).catch(() => undefined);
            }
            await nav(sameOriginPathOrHome(params.get("next")), { replace: true });
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <TextField
          name="name"
          label={t("field.displayName")}
          autoComplete="name"
          autoFocus
          isRequired
        />
        <TextField
          name="email"
          type="email"
          label={t("field.email")}
          autoComplete="email"
          spellCheck="false"
          isRequired
        />
        <TextField
          name="password"
          type="password"
          label={t("field.password")}
          autoComplete="new-password"
          minLength={12}
          isRequired
          description={t("auth.passwordHint")}
        />
        {askInvitation && (
          <>
            <TextField
              name="workspace"
              label={t("workspace.id")}
              description={t("workspace.idHint")}
              autoComplete="off"
              spellCheck="false"
              isRequired
            />
            <TextField
              name="token"
              label={t("invite.token")}
              autoComplete="off"
              spellCheck="false"
              isRequired
            />
          </>
        )}
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" isPending={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t("auth.creating") : t("auth.register")}
        </Button>
      </Form>
      <p className="mt-5  text-muted-foreground">
        {t("auth.haveAccount")}{" "}
        <Link to={signIn} className="font-medium text-primary hover:underline">
          {t("auth.login")}
        </Link>
      </p>
    </>
  );
}
