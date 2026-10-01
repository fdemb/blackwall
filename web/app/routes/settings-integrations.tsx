import { useState } from "react";
import { Form } from "react-aria-components";
import { Plug, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { Card, EmptyState } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { useToast } from "~/components/ui/toast";

export default function Integrations() {
  const t = useT();
  const { ws, run, canAdmin } = useWorkspace();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (!canAdmin)
    return (
      <Card>
        <EmptyState icon={<Plug />} title={t("integrations.adminOnly")} />
      </Card>
    );
  return (
    <>
      <div className="flex items-center">
        <div>
          <h2 className="text-[14px] font-semibold">{t("settings.integrations")}</h2>
          <p className="text-xs text-muted-foreground">{t("integrations.sub")}</p>
        </div>
        <Button variant="primary" size="sm" className="ml-auto" onPress={() => setOpen(true)}>
          <Plus />
          {t("integrations.add")}
        </Button>
      </div>
      <Card>
        {ws.integrations.length === 0 ? (
          <EmptyState
            icon={<Plug />}
            title={t("integrations.emptyTitle")}
            description={t("integrations.emptySub")}
          />
        ) : (
          <ul className="divide-y divide-border">
            {ws.integrations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{i.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{i.webhook_url}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    POST /api/workspaces/{ws.id}/integrations/{i.id}/webhook
                  </p>
                </div>
                <Switch
                  aria-label={t("integrations.enabled")}
                  isSelected={i.enabled}
                  onChange={(enabled) =>
                    run({ type: "update_integration", id: i.id, enabled }).catch(() => {})
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("action.delete")}
                  onPress={() =>
                    run({ type: "delete_integration", id: i.id })
                      .then(() => toast.show(t("integrations.deleted")))
                      .catch(() => {})
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">{t("integrations.help")}</p>
      <Dialog title={t("integrations.add")} size="sm" isOpen={open} onOpenChange={setOpen}>
        {(close) => <IntegrationForm close={close} />}
      </Dialog>
    </>
  );
}

function IntegrationForm({ close }: { close: () => void }) {
  const t = useT();
  const { run } = useWorkspace();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        await run({
          type: "create_integration",
          name: name.trim(),
          webhook_url: url.trim(),
          secret,
        })
          .then(close)
          .catch(() => {});
      }}
    >
      <TextField
        label={t("field.name")}
        value={name}
        onChange={setName}
        autoFocus
        isRequired
        placeholder="GitHub"
      />
      <TextField
        type="url"
        label={t("integrations.url")}
        value={url}
        onChange={setUrl}
        isRequired
        placeholder="https://"
        description={t("integrations.urlHint")}
      />
      <TextField
        type="password"
        label={t("integrations.secret")}
        value={secret}
        onChange={setSecret}
        isRequired
        minLength={16}
        description={t("integrations.secretHint")}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!name.trim() || !url.trim() || secret.length < 16}
        >
          {t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
