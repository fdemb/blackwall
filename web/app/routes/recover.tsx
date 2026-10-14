import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Loader2, MailCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { auth } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useDocumentTitle } from "~/lib/title";
import { useToast } from "~/components/ui/toast";
import { formText } from "~/lib/utils";

export default function Recover() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  // A link carrying ?token= (and optionally &email=) goes straight to choosing a new password.
  const [step, setStep] = useState<"request" | "reset">(params.get("token") ? "reset" : "request");
  const [requestError, setRequestError] = useState("");
  const [resetError, setResetError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(params.get("email") ?? "");
  useDocumentTitle(t("auth.recoverTitle"));

  /** Asks for a token. Resolves to an error message, or null when the request went through. */
  const request = async () => {
    setBusy(true);
    try {
      await auth.requestReset(email);
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      setBusy(false);
    }
  };

  if (step === "request")
    return (
      <>
        <h1 className="text-xl font-semibold tracking-tight">{t("auth.recoverTitle")}</h1>
        <p className="mb-6 mt-1 text-muted-foreground">{t("auth.recoverSub")}</p>
        <Form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setRequestError("");
            const failure = await request();
            if (failure) return setRequestError(failure);
            setResetError("");
            setStep("reset");
          }}
        >
          <TextField
            name="email"
            type="email"
            label={t("field.email")}
            value={email}
            onChange={setEmail}
            autoComplete="email"
            spellCheck="false"
            autoFocus
            isRequired
          />
          <FormError>{requestError}</FormError>
          <Button type="submit" variant="primary" size="lg" isPending={busy}>
            {busy && <Loader2 aria-hidden className="animate-spin" />}
            {busy ? t("auth.sending") : t("auth.sendLink")}
          </Button>
        </Form>
        <p className="mt-5 flex justify-between ">
          <Link to="/login" className="text-muted-foreground hover:text-foreground hover:underline">
            {t("auth.backToLogin")}
          </Link>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => {
              setRequestError("");
              setStep("reset");
            }}
          >
            {t("auth.haveToken")}
          </button>
        </p>
      </>
    );

  return (
    <>
      <MailCheck aria-hidden className="mb-3 size-7 text-primary" />
      <h1 className="text-xl font-semibold tracking-tight">{t("auth.checkMail")}</h1>
      <p className="mb-6 mt-1 text-muted-foreground">
        {email ? t("auth.checkMailSub", { email }) : t("auth.checkMailNoEmail")}
      </p>
      <Form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setResetError("");
          try {
            await auth.reset(formText(f, "token").trim(), formText(f, "password"));
            toast.show(t("auth.resetDone"));
            await nav("/login");
          } catch (err) {
            setResetError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <TextField
          name="token"
          label={t("auth.token")}
          defaultValue={params.get("token") ?? ""}
          autoComplete="one-time-code"
          spellCheck="false"
          inputMode="text"
          autoFocus
          isRequired
        />
        <TextField
          name="password"
          type="password"
          label={t("auth.newPassword")}
          autoComplete="new-password"
          minLength={12}
          isRequired
          description={t("auth.passwordHint")}
        />
        <FormError>{resetError}</FormError>
        <Button type="submit" variant="primary" size="lg" isPending={busy}>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy ? t("auth.updating") : t("auth.resetPassword")}
        </Button>
      </Form>
      <div className="mt-5 flex flex-wrap justify-between gap-2  text-muted-foreground">
        {email && (
          <button
            type="button"
            disabled={busy}
            className="hover:text-foreground hover:underline"
            onClick={async () => {
              setResetError("");
              const failure = await request();
              if (failure) setResetError(failure);
              else toast.show(t("auth.resent"));
            }}
          >
            {t("auth.resend")}
          </button>
        )}
        <button
          type="button"
          className="hover:text-foreground hover:underline"
          onClick={() => {
            setResetError("");
            setStep("request");
          }}
        >
          {t("auth.changeEmail")}
        </button>
        <Link to="/login" className="hover:text-foreground hover:underline">
          {t("auth.backToLogin")}
        </Link>
      </div>
    </>
  );
}
