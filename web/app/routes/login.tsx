import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate } from "react-router";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { auth, setCsrf } from "~/lib/api";
import { useT } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";

export default function Login() {
  const t = useT();
  const nav = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useDocumentTitle(t("auth.login"));
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{t("auth.welcomeBack")}</h1>
      <p className="mb-6 mt-1 text-muted-foreground">{t("auth.loginSub")}</p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            const s = await auth.login(String(f.get("email")), String(f.get("password")));
            setCsrf(s.csrf_token);
            nav("/", { replace: true });
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
          autoFocus
          isRequired
        />
        <TextField
          name="password"
          type="password"
          label={t("field.password")}
          autoComplete="current-password"
          isRequired
        />
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" isDisabled={busy}>
          {busy ? t("auth.signingIn") : t("auth.login")}
        </Button>
      </Form>
      <div className="mt-5 flex justify-between text-[13px] text-muted-foreground">
        <Link to="/recover" className="hover:text-foreground hover:underline">
          {t("auth.forgot")}
        </Link>
        <span>
          {t("auth.noAccount")}{" "}
          <Link to="/register" className="font-medium text-primary hover:underline">
            {t("auth.register")}
          </Link>
        </span>
      </div>
    </>
  );
}
