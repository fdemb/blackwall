import { useState } from "react";
import { Form } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "~/components/app/confirm";
import {
  SettingsList,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "~/components/app/settings";
import { auth, sessions } from "~/lib/api";
import { describeDevice } from "~/lib/device";
import { relativeTime, shortDate } from "~/lib/format";
import { useSession } from "~/lib/session";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { SessionInfo } from "~/lib/types";

const sessionsKey = ["sessions"] as const;

export default function Security() {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { logout } = useSession();
  const [error, setError] = useState("");
  return (
    <SettingsPage title={t("account.security")} description={t("account.securitySub")}>
      <SettingsSection title={t("account.password")}>
        <Form
          className="max-w-sm space-y-5 px-4 py-4 sm:px-5 sm:py-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setError("");
            try {
              await auth.changePassword(f.get("current") as string, f.get("next") as string);
              toast.show(t("account.passwordChanged"));
              form.reset();
              void client.invalidateQueries({ queryKey: sessionsKey });
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <TextField
            name="current"
            type="password"
            label={t("account.currentPassword")}
            autoComplete="current-password"
            isRequired
          />
          <TextField
            name="next"
            type="password"
            label={t("auth.newPassword")}
            autoComplete="new-password"
            minLength={12}
            isRequired
            error={error || undefined}
            description={t("auth.passwordHint")}
          />
          <Button type="submit" variant="secondary">
            {t("account.changePassword")}
          </Button>
        </Form>
      </SettingsSection>
      <Sessions />
      <SettingsSection>
        <SettingsRow label={t("nav.signOut")} description={t("account.signOutSub")}>
          <Button variant="secondary" onPress={() => logout()}>
            <LogOut />
            {t("nav.signOut")}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}

function Sessions() {
  const { t, lang } = useI18n();
  const { offline } = useWorkspace();
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: sessionsKey, queryFn: sessions.list });
  const [confirming, setConfirming] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: sessionsKey });
  const list = query.data ?? [];
  const deviceName = (session: SessionInfo) => {
    const { browser, os } = describeDevice(session.user_agent) ?? {};
    if (browser && os) return t("sessions.device", { browser, os });
    return browser ?? os ?? t("sessions.unknown");
  };
  const revoke = async (session: SessionInfo) => {
    try {
      await sessions.revoke(session.id);
      toast.show(t("sessions.revoked"));
    } catch {
      toast.error(t("error.generic"));
    }
    await refresh();
  };
  return (
    <SettingsSection
      title={t("sessions.title")}
      description={t("sessions.sub")}
      actions={
        list.length > 1 && (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={offline}
            onPress={() => setConfirming(true)}
          >
            {t("sessions.revokeOthers")}
          </Button>
        )
      }
    >
      {query.isPending ? (
        <p role="status" className="px-4 py-5 text-muted-foreground">
          {t("action.loading")}
        </p>
      ) : query.isError ? (
        <p role="alert" className="px-4 py-4">
          {t("error.generic")}
        </p>
      ) : (
        <SettingsList>
          {list.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1 basis-60">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{deviceName(session)}</span>
                  {session.current && <Badge>{t("sessions.current")}</Badge>}
                </p>
                <p className="truncate text-muted-foreground">
                  {t("sessions.signedIn", { date: shortDate(session.created_at, lang) })}
                  {session.last_seen_at &&
                    ` · ${t("sessions.active", { when: relativeTime(session.last_seen_at, lang) })}`}
                </p>
              </div>
              {!session.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${t("sessions.revoke")}: ${deviceName(session)}`}
                  isDisabled={offline}
                  onPress={() => void revoke(session)}
                >
                  {t("sessions.revoke")}
                </Button>
              )}
            </li>
          ))}
        </SettingsList>
      )}
      <ConfirmDialog
        title={t("sessions.revokeOthers")}
        description={t("sessions.revokeOthersSub")}
        confirmLabel={t("sessions.revokeOthers")}
        isOpen={confirming}
        onOpenChange={setConfirming}
        onConfirm={async () => {
          const { revoked } = await sessions.revokeOthers();
          await refresh();
          toast.show(t("sessions.revokedOthers", { count: revoked }));
        }}
      />
    </SettingsSection>
  );
}
