import { useState } from "react";
import { Form } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { SettingsRow, SettingsSection } from "~/components/app/settings";
import { ApiError, totp } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { formText } from "~/lib/utils";

const totpKey = ["totp"] as const;

/** Which dialog is open. Setup holds the new secret until a code confirms it. */
type Step =
  | { kind: "setup"; secret: string; qrSvg: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "disable" }
  | { kind: "regenerate" };

/** Turning TOTP on or off signs out other sessions, so the caller refreshes its list. */
export function TwoFactor({ onSessionsChanged }: { onSessionsChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: totpKey, queryFn: totp.status });
  const [step, setStep] = useState<Step | null>(null);
  const changed = () => {
    void client.invalidateQueries({ queryKey: totpKey });
    onSessionsChanged();
  };
  const start = async () => {
    try {
      const setup = await totp.setup();
      setStep({ kind: "setup", secret: setup.secret, qrSvg: setup.qr_svg });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const showCodes = (codes: string[]) => {
    setStep({ kind: "codes", codes });
    changed();
  };
  const dialog = (kind: Step["kind"]) => ({
    size: "sm" as const,
    isOpen: step?.kind === kind,
    onOpenChange: (open: boolean) => !open && setStep(null),
  });
  const status = query.data;
  return (
    <SettingsSection title={t("totp.title")} description={t("totp.sub")}>
      {query.isError ? (
        <p role="alert" className="px-4 py-4">
          {t("error.generic")}
        </p>
      ) : status?.enabled ? (
        <SettingsRow
          label={<Badge>{t("totp.on")}</Badge>}
          description={t("totp.codesLeft", { count: status.recovery_codes_left })}
        >
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onPress={() => setStep({ kind: "regenerate" })}>
              {t("totp.newCodes")}
            </Button>
            <Button size="sm" variant="secondary" onPress={() => setStep({ kind: "disable" })}>
              {t("totp.turnOff")}
            </Button>
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow label={t("totp.off")} description={t("totp.offSub")}>
          <Button variant="secondary" isDisabled={!status} onPress={() => void start()}>
            {t("totp.turnOn")}
          </Button>
        </SettingsRow>
      )}
      <Dialog title={t("totp.setupTitle")} {...dialog("setup")}>
        {step?.kind === "setup" && (
          <SetupForm secret={step.secret} qrSvg={step.qrSvg} onEnabled={showCodes} />
        )}
      </Dialog>
      <Dialog title={t("totp.codesTitle")} description={t("totp.codesSub")} {...dialog("codes")}>
        {(close) => step?.kind === "codes" && <RecoveryCodes codes={step.codes} close={close} />}
      </Dialog>
      <Dialog
        title={t("totp.newCodes")}
        description={t("totp.newCodesSub")}
        {...dialog("regenerate")}
      >
        <ConfirmForm
          submitLabel={t("totp.newCodes")}
          onConfirm={async (password, code) =>
            showCodes((await totp.regenerateCodes(password, code)).codes)
          }
        />
      </Dialog>
      <Dialog title={t("totp.turnOff")} description={t("totp.turnOffSub")} {...dialog("disable")}>
        <ConfirmForm
          submitLabel={t("totp.turnOff")}
          onConfirm={async (password, code) => {
            await totp.disable(password, code);
            setStep(null);
            changed();
            toast.show(t("totp.turnedOff"));
          }}
        />
      </Dialog>
    </SettingsSection>
  );
}

function SetupForm({
  secret,
  qrSvg,
  onEnabled,
}: {
  secret: string;
  qrSvg: string;
  onEnabled: (codes: string[]) => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          onEnabled((await totp.enable(formText(new FormData(e.currentTarget), "code"))).codes);
        } catch (err) {
          const wrong = err instanceof ApiError && err.status === 400;
          setError(wrong ? t("totp.wrongCode") : (err as Error).message);
        }
      }}
    >
      <p className="text-muted-foreground">{t("totp.scan")}</p>
      <div
        role="img"
        aria-label={t("totp.qr")}
        className="mx-auto size-48 overflow-hidden rounded-lg [&>svg]:size-full"
        // The server renders this SVG from the otpauth URI; it carries no user markup.
        dangerouslySetInnerHTML={{ __html: qrSvg }}
      />
      <div>
        <p className="text-muted-foreground">{t("totp.manual")}</p>
        <code className="mt-1 block break-all rounded-lg bg-muted p-2 font-mono text-[11px]">
          {secret}
        </code>
      </div>
      <TextField
        name="code"
        label={t("totp.code")}
        autoComplete="one-time-code"
        inputMode="numeric"
        spellCheck="false"
        isRequired
        error={error || undefined}
      />
      <Button type="submit" variant="primary">
        {t("totp.turnOn")}
      </Button>
    </Form>
  );
}

function ConfirmForm({
  submitLabel,
  onConfirm,
}: {
  submitLabel: string;
  onConfirm: (password: string, code: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setError("");
        try {
          await onConfirm(formText(f, "password"), formText(f, "code"));
        } catch (err) {
          const wrong = err instanceof ApiError && err.status === 400;
          setError(wrong ? t("totp.confirmWrong") : (err as Error).message);
        }
      }}
    >
      <TextField
        name="password"
        type="password"
        label={t("account.currentPassword")}
        autoComplete="current-password"
        isRequired
      />
      <TextField
        name="code"
        label={t("totp.code")}
        description={t("totp.codeHint")}
        autoComplete="one-time-code"
        spellCheck="false"
        isRequired
        error={error || undefined}
      />
      <Button type="submit" variant="primary">
        {submitLabel}
      </Button>
    </Form>
  );
}

function RecoveryCodes({ codes, close }: { codes: string[]; close: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <div className="flex flex-col gap-4">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted p-3 font-mono text-[12px]">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onPress={() =>
            void navigator.clipboard.writeText(codes.join("\n")).then(
              () => toast.show(t("action.copied")),
              () => toast.error(t("error.generic")),
            )
          }
        >
          <Copy />
          {t("action.copy")}
        </Button>
        <Button variant="primary" onPress={close}>
          {t("totp.savedCodes")}
        </Button>
      </div>
    </div>
  );
}
