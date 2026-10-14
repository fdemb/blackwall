import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { FormError } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/lib/i18n";
import { fullDate } from "~/lib/format";
import { useWorkspace } from "~/lib/workspace";
import { usePending } from "~/lib/use-pending";
import { syncApi, syncKey, syncProviderName, syncQuery } from "~/lib/sync";
import type { SyncConnection } from "~/lib/types";
import { EmptyState } from "../page";
import { SettingsList, SettingsSection } from "../settings";
import { ConfirmDialog } from "../confirm";
import { SyncWizard } from "./wizard";

/** `session` scopes a wizard's close to the opening that started it. */
type Editor = { connection: SyncConnection | null; session: number };

let sessions = 0;

const STATUS_TONE = {
  pending: "neutral",
  syncing: "primary",
  idle: "success",
  error: "danger",
} as const;

export function SyncSettings() {
  const { ws, canAdmin } = useWorkspace();
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ ...syncQuery(ws.id), enabled: canAdmin });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState<SyncConnection | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: syncKey(ws.id) });
  if (!canAdmin) return null;
  return (
    <SettingsSection
      title={t("sync.title")}
      description={t("sync.description")}
      actions={
        <Button size="sm" onPress={() => setEditor({ connection: null, session: ++sessions })}>
          <Plus />
          {t("sync.add")}
        </Button>
      }
    >
      {query.isPending ? (
        <p role="status" className="px-4 py-5 text-[13px] text-muted-foreground">
          {t("action.loading")}
        </p>
      ) : null}
      {query.isError ? (
        <div role="alert" className="px-4 py-4 text-[13px]">
          <p>{t("sync.loadError")}</p>
          <Button size="sm" variant="ghost" onPress={() => void query.refetch()}>
            {t("sync.retry")}
          </Button>
        </div>
      ) : null}
      {query.data?.connections.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title={t("sync.empty")}
          description={t("sync.emptySub")}
          action={
            <Button
              variant="primary"
              onPress={() => setEditor({ connection: null, session: ++sessions })}
            >
              {t("sync.add")}
            </Button>
          }
        />
      ) : null}
      <SettingsList>
        {query.data?.connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            refresh={refresh}
            edit={() => setEditor({ connection, session: ++sessions })}
            remove={() => setRemoving(connection)}
          />
        ))}
      </SettingsList>
      <Dialog
        size="lg"
        title={t(editor?.connection ? "sync.edit" : "sync.add")}
        isOpen={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        {editor && (
          <SyncWizard
            key={editor.session}
            editing={editor.connection}
            close={() => setEditor((open) => (open?.session === editor.session ? null : open))}
          />
        )}
      </Dialog>
      <ConfirmDialog
        title={t("sync.remove")}
        description={t("sync.removeSub")}
        confirmLabel={t("sync.disconnect")}
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await syncApi.remove(ws.id, removing.id);
          await refresh();
        }}
      />
    </SettingsSection>
  );
}

function ConnectionRow({
  connection,
  refresh,
  edit,
  remove,
}: {
  connection: SyncConnection;
  refresh: () => Promise<void>;
  edit: () => void;
  remove: () => void;
}) {
  const { ws } = useWorkspace();
  const { t, lang } = useI18n();
  const { pending, error, guard } = usePending();
  const toast = useToast();
  const syncNow = () =>
    guard(async () => {
      await syncApi.sync(ws.id, connection.id);
      toast.show(t("sync.queued"));
      await refresh();
    });
  return (
    <li className="space-y-2 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2">
            <span className="font-medium">{connection.name}</span>
            <span className="text-xs text-muted-foreground">
              {syncProviderName(connection.provider)}
            </span>
            <Badge tone={STATUS_TONE[connection.status]}>
              {t(`sync.status.${connection.status}`)}
            </Badge>
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {connection.base_url} · {t("sync.synced")}:{" "}
            {connection.last_synced_at
              ? fullDate(connection.last_synced_at, lang)
              : t("sync.never")}
          </p>
        </div>
        <Switch
          aria-label={`${t("sync.enabled")}: ${connection.name}`}
          isSelected={connection.enabled}
          isDisabled={pending}
          onChange={(enabled) =>
            void guard(async () => {
              await syncApi.update(ws.id, connection.id, { enabled });
              await refresh();
            })
          }
        />
        <Button
          size="sm"
          isDisabled={pending || !connection.enabled || connection.projects.length === 0}
          onPress={() => void syncNow()}
        >
          <RefreshCw />
          {t("sync.syncNow")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t("action.edit")}: ${connection.name}`}
          isDisabled={pending}
          onPress={edit}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${t("sync.disconnect")}: ${connection.name}`}
          isDisabled={pending}
          onPress={remove}
        >
          <Trash2 />
        </Button>
      </div>
      {connection.last_error ? (
        <p className="break-words text-xs text-destructive">
          {t("sync.error")}: {connection.last_error}
        </p>
      ) : null}
      {connection.push_error ? (
        <p className="break-words text-xs text-destructive">
          {t("sync.pushError", { message: connection.push_error })}
        </p>
      ) : null}
      {connection.pending_pushes ? (
        <p className="text-xs text-muted-foreground">
          {t("sync.pendingPushes", { count: connection.pending_pushes })}
        </p>
      ) : null}
      {connection.projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("sync.unfinished")}</p>
      ) : null}
      <FormError>{error}</FormError>
    </li>
  );
}
