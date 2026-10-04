import { useState } from "react";
import { Form } from "react-aria-components";
import { LogOut } from "lucide-react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsRow, SettingsSection } from "~/components/app/settings";
import { auth } from "~/lib/api";
import { useI18n } from "~/lib/i18n";

export default function Security() {
  const { t } = useI18n();
  const toast = useToast();
  const [error, setError] = useState("");
  return (
    <SettingsPage title={t("account.security")} description={t("account.securitySub")}>
      <SettingsSection title={t("account.password")}>
        <Form
          className="max-w-sm space-y-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setError("");
            try {
              await auth.changePassword(f.get("current") as string, f.get("next") as string);
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
          <Button type="submit" variant="secondary">
            {t("account.changePassword")}
          </Button>
        </Form>
      </SettingsSection>
      <SettingsSection>
        <SettingsRow label={t("nav.signOut")} description={t("account.signOutSub")}>
          <Button
            variant="secondary"
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
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
