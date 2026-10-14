import { Select } from "~/components/ui/select";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsRow, SettingsSection } from "~/components/app/settings";
import { useI18n } from "~/lib/i18n";
import { useSession } from "~/lib/session";
import { useShortcutsEnabled } from "~/lib/shortcuts";
import { usePending } from "~/lib/use-pending";
import type { Language, Profile, Theme } from "~/lib/types";

export default function Preferences() {
  const { t } = useI18n();
  const { profile, saveProfile } = useSession();
  const toast = useToast();
  const [shortcuts, setShortcuts] = useShortcutsEnabled();
  const { pending, guard } = usePending();
  const save = (patch: Partial<Pick<Profile, "language" | "theme">>) =>
    guard(async () => {
      await saveProfile(patch);
      toast.show(t("account.prefSaved"));
    }).then(() => undefined);
  return (
    <SettingsPage title={t("account.preferences")} description={t("account.preferencesSub")}>
      <SettingsSection title={t("account.appearance")}>
        <div className="divide-y divide-border">
          <SettingsRow label={t("pref.language")}>
            <Select
              aria-label={t("pref.language")}
              className="w-full sm:w-44"
              isDisabled={pending}
              selectedKey={profile.language}
              onSelectionChange={(k) => void save({ language: k as Language })}
              options={[
                { id: "en", label: "English" },
                { id: "pl", label: "Polski" },
              ]}
            />
          </SettingsRow>
          <SettingsRow label={t("pref.theme")}>
            <Select
              aria-label={t("pref.theme")}
              className="w-full sm:w-44"
              isDisabled={pending}
              selectedKey={profile.theme}
              onSelectionChange={(k) => void save({ theme: k as Theme })}
              options={(["light", "dark", "system"] as const).map((k) => ({
                id: k,
                label: t(`theme.${k}`),
              }))}
            />
          </SettingsRow>
        </div>
      </SettingsSection>
      <SettingsSection title={t("account.keyboard")}>
        <Switch
          isSelected={shortcuts}
          onChange={setShortcuts}
          className="flex-row-reverse items-start justify-between gap-8 px-4 py-4 sm:px-5"
        >
          <span>
            <span className="block font-medium">{t("account.shortcuts")}</span>
            <span className="mt-0.5 block max-w-prose  text-muted-foreground">
              {t("account.shortcutsSub")}
            </span>
          </span>
        </Switch>
      </SettingsSection>
    </SettingsPage>
  );
}
