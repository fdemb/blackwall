import { useState } from "react";
import { Form } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeySquare, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { EmptyState } from "~/components/app/page";
import { SettingsList, SettingsPage, SettingsSection } from "~/components/app/settings";
import { ConfirmDialog } from "~/components/app/confirm";
import { tokens } from "~/lib/api";
import { relativeTime, shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { ApiToken } from "~/lib/types";

const tokensKey = ["api-tokens"] as const;

export default function Tokens() {
  const { t, lang } = useI18n();
  const { offline } = useWorkspace();
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: tokensKey, queryFn: tokens.list });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: tokensKey });
  const list = query.data ?? [];
  const add = (
    <Button size="sm" isDisabled={offline} onPress={() => setCreating(true)}>
      <Plus />
      {t("tokens.add")}
    </Button>
  );
  return (
    <SettingsPage title={t("account.tokens")} description={t("tokens.sub")}>
      <SettingsSection title={t("account.tokens")} actions={list.length > 0 && add}>
        {query.isPending ? (
          <p role="status" className="px-4 py-5 text-muted-foreground">
            {t("action.loading")}
          </p>
        ) : query.isError ? (
          <p role="alert" className="px-4 py-4">
            {t("error.generic")}
          </p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<KeySquare />}
            title={t("tokens.emptyTitle")}
            description={t("tokens.emptySub")}
            action={
              <Button variant="primary" isDisabled={offline} onPress={() => setCreating(true)}>
                {t("tokens.add")}
              </Button>
            }
          />
        ) : (
          <SettingsList>
            {list.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="truncate">{token.name}</span>
                    <Badge>{t(token.access === "write" ? "tokens.write" : "tokens.read")}</Badge>
                  </p>
                  <p className="truncate text-muted-foreground">
                    <code className="font-mono text-[11px]">{token.prefix}…</code>
                    {" · "}
                    {token.workspace_ids ? t("tokens.scopeThis") : t("tokens.scopeAll")}
                    {" · "}
                    {token.last_used_at
                      ? t("tokens.used", { when: relativeTime(token.last_used_at, lang) })
                      : t("tokens.unused")}
                    {" · "}
                    {token.expires_at
                      ? t("tokens.expires", { date: shortDate(token.expires_at, lang) })
                      : t("tokens.noExpiry")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t("tokens.revoke")}: ${token.name}`}
                  isDisabled={offline}
                  onPress={() => setRevoking(token)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
      <SettingsSection title={t("integrations.setup")}>
        <div className="max-w-prose space-y-2 px-4 py-4 text-muted-foreground sm:px-5 sm:py-5">
          <p>{t("tokens.howApi")}</p>
          <p>{t("tokens.howMcp")}</p>
        </div>
      </SettingsSection>
      <Dialog title={t("tokens.add")} size="sm" isOpen={creating} onOpenChange={setCreating}>
        {(close) => (
          <TokenForm
            close={close}
            onCreated={(secret) => {
              setCreated(secret);
              void refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog
        title={t("tokens.createdTitle")}
        description={t("tokens.createdSub")}
        size="sm"
        isOpen={created !== null}
        onOpenChange={(open) => !open && setCreated(null)}
      >
        {(close) => (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-1 rounded-lg bg-muted p-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{created}</code>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("action.copy")}
                onPress={() =>
                  void navigator.clipboard.writeText(created ?? "").then(
                    () => toast.show(t("action.copied")),
                    () => toast.error(t("error.generic")),
                  )
                }
              >
                <Copy />
              </Button>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" onPress={close}>
                {t("action.close")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        title={t("tokens.revokeTitle")}
        description={t("tokens.revokeSub")}
        confirmLabel={t("tokens.revoke")}
        isOpen={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        onConfirm={async () => {
          await tokens.revoke(revoking!.id);
          await refresh();
          toast.show(t("tokens.revoked"));
        }}
      />
    </SettingsPage>
  );
}

const EXPIRY = ["30", "90", "365", "never"] as const;

function TokenForm({
  close,
  onCreated,
}: {
  close: () => void;
  onCreated: (secret: string) => void;
}) {
  const { t } = useI18n();
  const { ws, offline } = useWorkspace();
  const { pending, error, guard } = usePending();
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ApiToken["access"]>("read");
  const [scope, setScope] = useState<"this" | "all">("this");
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>("90");
  useDialogDirty(name !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          const token = await tokens.create({
            name: name.trim(),
            access,
            workspace_ids: scope === "this" ? [ws.id] : undefined,
            expires_in_days: expiry === "never" ? undefined : Number(expiry),
          });
          close();
          onCreated(token.secret);
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
        maxLength={100}
        placeholder={t("tokens.namePlaceholder")}
      />
      <Select
        label={t("tokens.access")}
        selectedKey={access}
        onSelectionChange={(k) => setAccess(k as ApiToken["access"])}
        options={[
          { id: "read", label: t("tokens.read") },
          { id: "write", label: t("tokens.write") },
        ]}
      />
      <Select
        label={t("tokens.scope")}
        selectedKey={scope}
        onSelectionChange={(k) => setScope(k as "this" | "all")}
        options={[
          { id: "this", label: t("tokens.scopeOnly", { name: ws.name }) },
          { id: "all", label: t("tokens.scopeAll") },
        ]}
      />
      <Select
        label={t("tokens.expiry")}
        selectedKey={expiry}
        onSelectionChange={(k) => setExpiry(k as (typeof EXPIRY)[number])}
        options={EXPIRY.map((id) => ({
          id,
          label: id === "never" ? t("tokens.noExpiry") : t("tokens.days", { count: Number(id) }),
        }))}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!name.trim() || offline}
          isPending={pending}
        >
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          {pending ? t("action.saving") : t("tokens.create")}
        </Button>
      </div>
    </Form>
  );
}
