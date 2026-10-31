import { useState } from "react";
import { Form, TextField as RACTextField } from "react-aria-components";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FieldError, FormError, Input, Label, TextField } from "~/components/ui/field";
import { ApiError, auth, setCsrf, type SignedIn } from "~/lib/api";
import { sameOriginPathOrHome } from "~/lib/auth-guard";
import { signedInAs } from "~/lib/session-replicas";
import { useI18n } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";
import { formText } from "~/lib/utils";

export default function Login() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  useDocumentTitle(t("auth.login"));
  const signedIn = async ({ csrf_token, profile }: SignedIn) => {
    setCsrf(csrf_token);
    await signedInAs(profile.id);
    await nav(sameOriginPathOrHome(params.get("next")), { replace: true });
  };
  if (pendingToken !== null) {
    return (
      <TotpStep
        pendingToken={pendingToken}
        onSignedIn={signedIn}
        onBack={(message) => {
          setPendingToken(null);
          setError(message);
          setBusy(false);
        }}
      />
    );
  }
  return (
    <>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">
        {t("auth.welcomeBack")}
      </h1>
      <p className="mb-6 mt-1 text-muted-foreground">{t("auth.loginSub")}</p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            const s = await auth.login(formText(f, "email"), formText(f, "password"));
            if ("pending_token" in s) setPendingToken(s.pending_token);
            else await signedIn(s);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <TextField
          name="email"
          type="email"
          label={t("field.email")}
          autoComplete="email"
          spellCheck="false"
          autoFocus
          isRequired
        />
        <RACTextField
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          isRequired
          className="flex flex-col"
        >
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <Label className="mb-0">{t("field.password")}</Label>
            <Link
              to="/recover"
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {t("auth.forgot")}
            </Link>
          </div>
          <div className="relative">
            <Input className="pr-9" />
            <Button
              variant="ghost"
              size="icon"
              aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
              onPress={() => setShowPassword((v) => !v)}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <FieldError />
        </RACTextField>
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" isPending={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t("auth.signingIn") : t("auth.login")}
        </Button>
      </Form>
      <p className="mt-5 text-center text-muted-foreground">
        {t("auth.noAccount")}{" "}
        <Link
          to={{ pathname: "/register", search: params.toString() }}
          className="font-medium text-primary hover:underline"
        >
          {t("auth.register")}
        </Link>
      </p>
    </>
  );
}

function TotpStep({
  pendingToken,
  onSignedIn,
  onBack,
}: {
  pendingToken: string;
  onSignedIn: (signedIn: SignedIn) => Promise<void>;
  onBack: (message: string) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">{t("totp.loginTitle")}</h1>
      <p className="mb-6 mt-1 text-muted-foreground">{t("totp.loginSub")}</p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const code = formText(new FormData(e.currentTarget), "code");
          setBusy(true);
          setError("");
          try {
            await onSignedIn(await auth.loginTotp(pendingToken, code));
          } catch (err) {
            setBusy(false);
            const status = err instanceof ApiError ? err.status : 0;
            if (status === 400) onBack(t("totp.expired"));
            else setError(status === 401 ? t("totp.wrongCode") : (err as Error).message);
          }
        }}
      >
        <TextField
          name="code"
          label={t("totp.code")}
          description={t("totp.codeHint")}
          autoComplete="one-time-code"
          spellCheck="false"
          autoFocus
          isRequired
        />
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" isPending={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t("auth.signingIn") : t("auth.login")}
        </Button>
        <Button variant="ghost" onPress={() => onBack("")}>
          {t("auth.backToLogin")}
        </Button>
      </Form>
    </>
  );
}
