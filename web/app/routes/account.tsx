import { useState } from "react";
import { Form } from "react-aria-components";
import { LogOut } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { Card, Page, PageHeader, Scroll } from "~/components/app/page";
import { auth } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useSession } from "~/lib/session";
import { useWorkspace } from "~/lib/workspace";
import type { Language, Theme } from "~/lib/types";

export default function Account() {
  const t = useI18n().t;
  return (
    <Page>
      <PageHeader
        title={t("nav.account")}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onPress={() =>
              auth.logout().finally(() => {
                sessionStorage.clear();
                location.href = "/login";
              })
            }
          >
            <LogOut />
            {t("nav.signOut")}
          </Button>
        }
      />
      <Scroll>
        <div className="mx-auto max-w-2xl space-y-5 p-6">
          <ProfileCard />
          <PreferencesCard />
          <AlertsCard />
          <PasswordCard />
        </div>
      </Scroll>
    </Page>
  );
}

function CardShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function ProfileCard() {
  const t = useI18n().t;
  const { profile, saveProfile } = useSession();
  const toast = useToast();
  const [name, setName] = useState(profile.display_name);
  const [contact, setContact] = useState(profile.contact);
  const [avatar, setAvatar] = useState(profile.avatar_url ?? "");
  const [error, setError] = useState("");
  const invalidAvatar = avatar !== "" && !avatar.startsWith("https://");
  return (
    <CardShell title={t("account.profile")} description={t("account.profileSub")}>
      <Form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await saveProfile({
              display_name: name.trim(),
              contact,
              avatar_url: avatar.trim() || null,
            });
            toast.show(t("account.saved"));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="flex items-center gap-4">
          <Avatar
            name={name || profile.email}
            src={!invalidAvatar && avatar ? avatar : null}
            size={56}
          />
          <TextField
            className="flex-1"
            label={t("account.avatar")}
            description={t("account.avatarHint")}
            value={avatar}
            onChange={setAvatar}
            placeholder="https://"
            error={invalidAvatar ? t("account.avatarInvalid") : undefined}
          />
        </div>
        <TextField
          label={t("field.displayName")}
          value={name}
          onChange={setName}
          isRequired
          maxLength={120}
        />
        <TextField label={t("field.email")} value={profile.email} isReadOnly />
        <TextField
          label={t("field.contact")}
          description={t("account.contactHint")}
          value={contact}
          onChange={setContact}
          multiline
          rows={2}
          maxLength={2000}
          error={error || undefined}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" isDisabled={!name.trim() || invalidAvatar}>
            {t("action.save")}
          </Button>
        </div>
      </Form>
    </CardShell>
  );
}

function PreferencesCard() {
  const t = useI18n().t;
  const { profile, saveProfile } = useSession();
  return (
    <CardShell title={t("account.preferences")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label={t("pref.language")}
          selectedKey={profile.language}
          onSelectionChange={(k) => saveProfile({ language: k as Language })}
          options={[
            { id: "en", label: "English" },
            { id: "pl", label: "Polski" },
          ]}
        />
        <Select
          label={t("pref.theme")}
          selectedKey={profile.theme}
          onSelectionChange={(k) => saveProfile({ theme: k as Theme })}
          options={(["light", "dark", "system"] as const).map((k) => ({
            id: k,
            label: t(`theme.${k}`),
          }))}
        />
      </div>
    </CardShell>
  );
}

function AlertsCard() {
  const t = useI18n().t;
  const { profile, saveProfile } = useSession();
  const { ws, me, run } = useWorkspace();
  const mine = ws.alert_preferences.find((p) => p.user_id === me);
  const prefs = {
    assignment: mine?.assignment ?? profile.alerts.assignments,
    reply: mine?.reply ?? profile.alerts.replies,
    change: mine?.change ?? profile.alerts.changes,
    mention: mine?.mention ?? true,
    deadline: mine?.deadline ?? profile.alerts.deadlines,
  };
  const set = async (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    await run({ type: "configure_alerts", ...next }).catch(() => {});
    await saveProfile({
      alerts: {
        assignments: next.assignment,
        replies: next.reply,
        changes: next.change,
        deadlines: next.deadline,
      },
    }).catch(() => {});
  };
  return (
    <CardShell title={t("account.alerts")} description={t("account.alertsSub", { name: ws.name })}>
      <div className="space-y-3.5">
        {(["assignment", "reply", "change", "mention", "deadline"] as const).map((k) => (
          <Switch
            key={k}
            isSelected={prefs[k]}
            onChange={(v) => set({ [k]: v })}
            className="justify-between flex-row-reverse"
          >
            <span>
              <span className="block font-medium">{t(`alert.${k}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`alert.${k}Sub`)}</span>
            </span>
          </Switch>
        ))}
      </div>
    </CardShell>
  );
}

function PasswordCard() {
  const t = useI18n().t;
  const toast = useToast();
  const [error, setError] = useState("");
  return (
    <CardShell title={t("account.password")}>
      <Form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          setError("");
          try {
            await auth.changePassword(String(f.get("current")), String(f.get("next")));
            toast.show(t("account.passwordChanged"));
            form.reset();
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
        <div className="flex justify-end">
          <Button type="submit" variant="secondary">
            {t("account.changePassword")}
          </Button>
        </div>
      </Form>
    </CardShell>
  );
}
