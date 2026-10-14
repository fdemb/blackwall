import { useEffect, useRef, useState } from "react";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { useI18n } from "~/lib/i18n";
import { useSession } from "~/lib/session";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";

const KINDS = ["assignment", "reply", "change", "mention", "deadline"] as const;

type Prefs = Record<(typeof KINDS)[number], boolean>;

const STATUS_LABEL = {
  saving: "account.alertsSaving",
  saved: "account.alertsSaved",
  failed: "account.alertsFailed",
} as const;

/** This workspace's choices, falling back to the profile defaults; mentions default on. */
function storedAlerts(
  mine: Partial<Prefs> | undefined,
  defaults: { assignments: boolean; replies: boolean; changes: boolean; deadlines: boolean },
): Prefs {
  return {
    assignment: mine?.assignment ?? defaults.assignments,
    reply: mine?.reply ?? defaults.replies,
    change: mine?.change ?? defaults.changes,
    mention: mine?.mention ?? true,
    deadline: mine?.deadline ?? defaults.deadlines,
  };
}

export default function Notifications() {
  const { t } = useI18n();
  const toast = useToast();
  const { profile, saveProfile } = useSession();
  const { ws, me, run } = useWorkspace();
  const stored = storedAlerts(
    ws.alert_preferences.find((p) => p.user_id === me),
    profile.alerts,
  );
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
      // The profile keeps a default copy for new workspaces. A failure here doesn't undo the saved choice.
      await saveProfile({
        alerts: {
          assignments: want.assignment,
          replies: want.reply,
          changes: want.change,
          deadlines: want.deadline,
        },
      }).catch((e: Error) => toast.error(e.message));
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
        <div className="divide-y divide-border">
          {KINDS.map((k) => (
            <Switch
              key={k}
              isSelected={local[k]}
              onChange={(v) => set({ [k]: v })}
              className="flex-row-reverse justify-between gap-8 px-4 py-4 sm:px-5"
            >
              <span>
                <span className="block font-medium">{t(`alert.${k}`)}</span>
                <span className="mt-0.5 block  text-muted-foreground">{t(`alert.${k}Sub`)}</span>
              </span>
            </Switch>
          ))}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
