import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate } from "react-router";
import { MailCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { auth } from "~/lib/api";
import { useT } from "~/lib/i18n";
import { useToast } from "~/components/ui/toast";

export default function Recover() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<"request" | "reset">("request");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");

  if (step === "request")
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight">{t("auth.recoverTitle")}</h1>
        <p className="mb-6 mt-1 text-muted-foreground">{t("auth.recoverSub")}</p>
        <Form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await auth.requestReset(email);
              setStep("reset");
            } catch (err) {
              setError((err as Error).message);
            }
            setBusy(false);
          }}
        >
          <TextField name="email" type="email" label={t("field.email")} value={email} onChange={setEmail} autoFocus isRequired error={error} />
          <Button type="submit" variant="primary" size="lg" isDisabled={busy}>{t("auth.sendLink")}</Button>
        </Form>
        <p className="mt-5 text-[13px]"><Link to="/login" className="text-muted-foreground hover:text-foreground hover:underline">{t("auth.backToLogin")}</Link></p>
      </>
    );

  return (
    <>
      <MailCheck className="mb-3 size-7 text-primary" />
      <h1 className="text-xl font-semibold tracking-tight">{t("auth.checkMail")}</h1>
      <p className="mb-6 mt-1 text-muted-foreground">{t("auth.checkMailSub", { email })}</p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await auth.reset(String(f.get("token")).trim(), String(f.get("password")));
            toast.show(t("auth.resetDone"));
            nav("/login");
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <TextField name="token" label={t("auth.token")} autoFocus isRequired />
        <TextField name="password" type="password" label={t("auth.newPassword")} autoComplete="new-password" minLength={12} isRequired error={error} />
        <Button type="submit" variant="primary" size="lg" isDisabled={busy}>{t("auth.resetPassword")}</Button>
      </Form>
    </>
  );
}
