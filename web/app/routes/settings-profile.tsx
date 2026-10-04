import { useState } from "react";
import { Form } from "react-aria-components";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { useT } from "~/lib/i18n";
import { useSession } from "~/lib/session";

export default function Profile() {
  const t = useT();
  const { profile, saveProfile } = useSession();
  const toast = useToast();
  const [name, setName] = useState(profile.display_name);
  const [contact, setContact] = useState(profile.contact);
  const [avatar, setAvatar] = useState(profile.avatar_url ?? "");
  const [error, setError] = useState("");
  const invalidAvatar = avatar !== "" && !avatar.startsWith("https://");
  const dirty =
    name !== profile.display_name ||
    contact !== profile.contact ||
    avatar !== (profile.avatar_url ?? "");
  return (
    <SettingsPage title={t("account.profile")} description={t("account.profileSub")}>
      <SettingsSection>
        <Form
          className="space-y-5 px-4 py-4 sm:px-5 sm:py-5"
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
          <div className="flex items-start gap-4">
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
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label={t("field.displayName")}
              value={name}
              onChange={setName}
              isRequired
              maxLength={120}
            />
            <TextField label={t("field.email")} value={profile.email} isReadOnly />
          </div>
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
            <Button
              type="submit"
              variant="primary"
              isDisabled={!dirty || !name.trim() || invalidAvatar}
            >
              {t("action.save")}
            </Button>
          </div>
        </Form>
      </SettingsSection>
    </SettingsPage>
  );
}
