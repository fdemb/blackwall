import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { auth, setCsrf } from "~/lib/api";
import { useT } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";
import { formText } from "~/lib/utils";

export default function Register() {
  const t = useT();
  const nav = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useDocumentTitle(t("auth.register"));
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{t("auth.createAccount")}</h1>
      <p className="mb-6 mt-1 text-muted-foreground">{t("auth.registerSub")}</p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            const s = await auth.register(
              formText(f, "email"),
              formText(f, "password"),
              formText(f, "name"),
            );
            setCsrf(s.csrf_token);
            await nav("/", { replace: true });
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
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" isPending={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t("auth.creating") : t("auth.register")}
        </Button>
      </Form>
      <p className="mt-5 text-[13px] text-muted-foreground">
        {t("auth.haveAccount")}{" "}
        <Link to="/login" className="font-medium text-primary hover:underline">
          {t("auth.login")}
        </Link>
      </p>
    </>
  );
}
