import { useEffect, useRef, useState } from "react";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import {
  ALERT_KINDS,
  alertSwitch,
  storedAlerts,
  type AlertChannel,
  type AlertPrefs,
} from "~/lib/alerts";
import { cn } from "~/lib/utils";

const STATUS_LABEL = {
  saving: "account.alertsSaving",
  saved: "account.alertsSaved",
  failed: "account.alertsFailed",
} as const;

export default function Notifications() {
  const { t } = useI18n();
  const toast = useToast();
  const { ws, me, run } = useWorkspace();
  const stored = storedAlerts(ws.alert_preferences.find((p) => p.user_id === me));
  const storedRef = useRef(stored);
  useEffect(() => {
    storedRef.current = stored;
  });
  // The switches show `local` at once. Saves go one at a time and always send the newest choice, so two
  // quick toggles can't overwrite each other with a stale snapshot.
  const [local, setLocal] = useState<AlertPrefs>(stored);
  const latest = useRef<AlertPrefs>(stored);
  const sent = useRef<AlertPrefs | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const set = (patch: Partial<AlertPrefs>) => {
    latest.current = { ...latest.current, ...patch };
    setLocal(latest.current);
    setStatus("saving");
    chain.current = chain.current.then(async () => {
      const want = latest.current;
      if (sent.current === want) return;
      try {
        await run({ type: "configure_alerts", ...want }, { quiet: true });
        sent.current = want;
      } catch (e) {
        toast.error((e as Error).message);
        latest.current = storedRef.current;
        sent.current = null;
        setLocal(storedRef.current);
        return setStatus("failed");
      }
      if (latest.current === want) setStatus("saved");
    });
  };
  return (
    <SettingsPage
      title={t("account.alerts")}
      description={t("account.alertsSub", { name: ws.name })}
    >
      <SettingsSection
        title={t("account.alertsInbox")}
        actions={
          <p
            role="status"
            className={cn("", status === "failed" ? "text-destructive" : "text-muted-foreground")}
          >
            {status === "idle" ? "" : t(STATUS_LABEL[status])}
          </p>
        }
      >
        <Switches channel="inbox" local={local} set={set} />
      </SettingsSection>
      <SettingsSection title={t("account.alertsEmail")} description={t("account.alertsEmailSub")}>
        <Switches channel="email" local={local} set={set} />
      </SettingsSection>
    </SettingsPage>
  );
}

function Switches({
  channel,
  local,
  set,
}: {
  channel: AlertChannel;
  local: AlertPrefs;
  set: (patch: Partial<AlertPrefs>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="divide-y divide-border">
      {ALERT_KINDS.map((k) => {
        const { field, selected, disabled } = alertSwitch(local, channel, k);
        return (
          <Switch
            key={k}
            isSelected={selected}
            isDisabled={disabled}
            onChange={(v) => set({ [field]: v })}
            className="flex-row-reverse justify-between gap-8 px-4 py-4 sm:px-5"
          >
            <span>
              <span className="block font-medium">{t(`alert.${k}`)}</span>
              <span className="mt-0.5 block  text-muted-foreground">{t(`alert.${k}Sub`)}</span>
            </span>
          </Switch>
        );
      })}
    </div>
  );
}
