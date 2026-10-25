import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { Link, useSearchParams } from "react-router";
import { Loader2, MailCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { auth } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";
import { formText } from "~/lib/utils";

export default function Verify() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [linked] = useState(() => params.get("token")?.trim() ?? "");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(linked !== "");
  const started = useRef(false);
  useDocumentTitle(t("auth.verifyTitle"));

  const submit = async (token: string) => {
    setBusy(true);
    setError("");
    try {
      await auth.verify(token);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!linked || started.current) return;
    started.current = true;
    setParams({}, { replace: true });
    void submit(linked);
  }, [linked, setParams]);

  if (done)
    return (
      <>
        <MailCheck aria-hidden className="mb-3 size-7 text-primary" />
        <h1 className="text-balance text-3xl font-semibold tracking-tight">{t("auth.verified")}</h1>
        <p className="mb-6 mt-1 text-muted-foreground">{t("auth.verifiedSub")}</p>
        <Link to="/login" className="font-medium text-primary hover:underline">
          {t("auth.login")}
        </Link>
      </>
    );

  return (
    <>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">
        {t("auth.verifyTitle")}
      </h1>
      <p className="mb-6 mt-1 text-muted-foreground">{t("auth.verifySub")}</p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          await submit(formText(new FormData(e.currentTarget), "token").trim());
        }}
      >
        <TextField
          name="token"
          label={t("auth.verifyToken")}
          defaultValue={linked}
          autoComplete="one-time-code"
          spellCheck="false"
          autoFocus
          isRequired
        />
        <FormError>{error}</FormError>
        <Button type="submit" variant="primary" size="lg" isPending={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t("auth.verifying") : t("auth.verify")}
        </Button>
      </Form>
      <p className="mt-5">
        <Link to="/login" className="text-muted-foreground hover:text-foreground hover:underline">
          {t("auth.backToLogin")}
        </Link>
      </p>
    </>
  );
}
