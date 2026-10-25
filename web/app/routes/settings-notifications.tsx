import { useEffect, useRef, useState } from "react";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";

const KINDS = ["assignment", "reply", "change", "mention", "deadline"] as const;

type Kind = (typeof KINDS)[number];
type Prefs = Record<Kind | `email_${Kind}`, boolean>;

const CHANNELS = {
  inbox: (k: Kind) => k,
  email: (k: Kind) => `email_${k}` as const,
};

/** The server's column defaults, for a member who has never saved a choice. */
const DEFAULTS: Prefs = {
  assignment: true,
  reply: true,
  change: true,
  mention: true,
  deadline: true,
  email_assignment: true,
  email_reply: true,
  email_change: false,
  email_mention: true,
  email_deadline: true,
};

const STATUS_LABEL = {
  saving: "account.alertsSaving",
  saved: "account.alertsSaved",
  failed: "account.alertsFailed",
} as const;

function storedAlerts(mine: Partial<Prefs> | undefined): Prefs {
  const entries = Object.entries(DEFAULTS).map(([field, on]) => [
    field,
    mine?.[field as keyof Prefs] ?? on,
  ]);
  return Object.fromEntries(entries) as Prefs;
}

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
  const [local, setLocal] = useState<Prefs>(stored);
  const latest = useRef<Prefs>(stored);
  const sent = useRef<Prefs | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const set = (patch: Partial<Prefs>) => {
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
  channel: keyof typeof CHANNELS;
  local: Prefs;
  set: (patch: Partial<Prefs>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="divide-y divide-border">
      {KINDS.map((k) => {
        const field = CHANNELS[channel](k);
        return (
          <Switch
            key={k}
            isSelected={local[field]}
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
