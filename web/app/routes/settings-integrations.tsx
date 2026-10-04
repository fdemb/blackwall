import { useState } from "react";
import { Form } from "react-aria-components";
import { Copy, Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { EmptyState } from "~/components/app/page";
import { SettingsList, SettingsPage, SettingsSection } from "~/components/app/settings";
import { ConfirmDialog } from "~/components/app/confirm";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import { useToast } from "~/components/ui/toast";
import type { Integration } from "~/lib/types";

export default function Integrations() {
  const { t } = useI18n();
  const { ws, run, canAdmin } = useWorkspace();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<Integration | null>(null);
  if (!canAdmin)
    return (
      <SettingsPage title={t("settings.integrations")} description={t("integrations.sub")}>
        <SettingsSection>
          <EmptyState icon={<Plug />} title={t("integrations.adminOnly")} />
        </SettingsSection>
      </SettingsPage>
    );
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = (i: Integration) =>
    `${origin}/api/workspaces/${ws.id}/integrations/${i.id}/webhook`;
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.show(t("action.copied")),
      () => toast.error(t("error.generic")),
    );
  const sample = ws.integrations[0]
    ? endpoint(ws.integrations[0])
    : `${origin}/api/workspaces/${ws.id}/integrations/<id>/webhook`;
  return (
    <SettingsPage
      title={t("settings.integrations")}
      description={t("integrations.sub")}
      actions={
        <Button variant="primary" size="sm" onPress={() => setOpen(true)}>
          <Plus />
          {t("integrations.add")}
        </Button>
      }
    >
      <SettingsSection>
        {ws.integrations.length === 0 ? (
          <EmptyState
            icon={<Plug />}
            title={t("integrations.emptyTitle")}
            description={t("integrations.emptySub")}
            action={
              <Button variant="primary" onPress={() => setOpen(true)}>
                {t("integrations.add")}
              </Button>
            }
          />
        ) : (
          <SettingsList>
            {ws.integrations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-3 text-[13px]">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium">{i.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{i.webhook_url}</p>
                  <div className="mt-1 flex items-center gap-1">
                    <code
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                      title={endpoint(i)}
                      aria-label={t("integrations.endpoint")}
                    >
                      {endpoint(i)}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${t("action.copy")}: ${t("integrations.endpoint")}`}
                      onPress={() => void copy(endpoint(i))}
                    >
                      <Copy />
                    </Button>
                  </div>
                </div>
                <Switch
                  aria-label={`${t("integrations.enabled")}: ${i.name}`}
                  isSelected={i.enabled}
                  onChange={(enabled) =>
                    run({ type: "update_integration", id: i.id, enabled }).catch(() => {})
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("action.delete")}: ${i.name}`}
                  onPress={() => setRemoving(i)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
      <SettingsSection title={t("integrations.setup")}>
        <div className="max-w-prose space-y-2 text-[13px] text-muted-foreground">
          <p>{t("integrations.setupOut")}</p>
          <p>{t("integrations.setupIn")}</p>
        </div>
        <p className="mt-4 text-xs font-medium">{t("integrations.example")}</p>
        <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-5">{`body='{"delivery_id":"<uuid>","issue_id":"<issue uuid>","url":"https://git.example/pr/7","title":"Fix login"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -X POST "${sample}" \\
  -H "X-Blackwall-Signature: sha256=$sig" -H "Content-Type: application/json" -d "$body"`}</pre>
      </SettingsSection>
      <Dialog title={t("integrations.add")} size="sm" isOpen={open} onOpenChange={setOpen}>
        {(close) => <IntegrationForm close={close} />}
      </Dialog>
      <ConfirmDialog
        title={t("integrations.deleteTitle")}
        description={t("integrations.deleteSub")}
        isOpen={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        onConfirm={async () => {
          await run({ type: "delete_integration", id: removing!.id }, { quiet: true });
          toast.show(t("integrations.deleted"));
        }}
      />
    </SettingsPage>
  );
}

function IntegrationForm({ close }: { close: () => void }) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const { pending, error, guard } = usePending();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  useDialogDirty(name !== "" || url !== "" || secret !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "create_integration", name: name.trim(), webhook_url: url.trim(), secret },
            { quiet: true },
          );
          close();
        });
      }}
    >
      <TextField
        label={t("field.name")}
        value={name}
        onChange={setName}
        autoComplete="off"
        spellCheck="false"
        autoFocus
        isRequired
        placeholder={t("integrations.namePlaceholder")}
      />
      <TextField
        type="url"
        label={t("integrations.url")}
        value={url}
        onChange={setUrl}
        autoComplete="off"
        spellCheck="false"
        inputMode="url"
        isRequired
        placeholder="https://"
        description={t("integrations.urlHint")}
      />
      <TextField
        type="password"
        label={t("integrations.secret")}
        value={secret}
        onChange={setSecret}
        autoComplete="new-password"
        spellCheck="false"
        isRequired
        minLength={16}
        description={t("integrations.secretHint")}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!name.trim() || !url.trim() || secret.length < 16}
          isPending={pending}
        >
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
