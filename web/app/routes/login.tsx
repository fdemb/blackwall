import { useState } from "react";
import { Form, TextField as RACTextField } from "react-aria-components";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FieldError, FormError, Input, Label, TextField } from "~/components/ui/field";
import { auth, setCsrf } from "~/lib/api";
import { sameOriginPathOrHome } from "~/lib/auth-guard";
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
  useDocumentTitle(t("auth.login"));
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
            setCsrf(s.csrf_token);
            await nav(sameOriginPathOrHome(params.get("next")), { replace: true });
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
