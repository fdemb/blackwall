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
import { trackerApi, trackerKey, trackerProviderName, trackerQuery } from "~/lib/trackers";
import type { TrackerConnection } from "~/lib/types";
import { EmptyState } from "../page";
import { SettingsList, SettingsSection } from "../settings";
import { ConfirmDialog } from "../confirm";
import { TrackerWizard } from "./wizard";

/** `session` scopes a wizard's close to the opening that started it. */
type Editor = { connection: TrackerConnection | null; session: number };

let sessions = 0;

const STATUS_TONE = {
  pending: "neutral",
  syncing: "primary",
  idle: "success",
  error: "danger",
} as const;

export function TrackerSettings() {
  const { ws, canAdmin } = useWorkspace();
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ ...trackerQuery(ws.id), enabled: canAdmin });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState<TrackerConnection | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: trackerKey(ws.id) });
  if (!canAdmin) return null;
  return (
    <SettingsSection
      title={t("tracker.title")}
      description={t("tracker.description")}
      actions={
        <Button size="sm" onPress={() => setEditor({ connection: null, session: ++sessions })}>
          <Plus />
          {t("tracker.add")}
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
          <p>{t("tracker.loadError")}</p>
          <Button size="sm" variant="ghost" onPress={() => void query.refetch()}>
            {t("tracker.retry")}
          </Button>
        </div>
      ) : null}
      {query.data?.connections.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title={t("tracker.empty")}
          description={t("tracker.emptySub")}
          action={
            <Button
              variant="primary"
              onPress={() => setEditor({ connection: null, session: ++sessions })}
            >
              {t("tracker.add")}
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
        title={t(editor?.connection ? "tracker.edit" : "tracker.add")}
        isOpen={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        {editor && (
          <TrackerWizard
            key={editor.session}
            editing={editor.connection}
            close={() => setEditor((open) => (open?.session === editor.session ? null : open))}
          />
        )}
      </Dialog>
      <ConfirmDialog
        title={t("tracker.remove")}
        description={t("tracker.removeSub")}
        confirmLabel={t("tracker.disconnect")}
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await trackerApi.remove(ws.id, removing.id);
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
  connection: TrackerConnection;
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
      await trackerApi.sync(ws.id, connection.id);
      toast.show(t("tracker.queued"));
      await refresh();
    });
  return (
    <li className="space-y-2 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2">
            <span className="font-medium">{connection.name}</span>
            <span className="text-xs text-muted-foreground">
              {trackerProviderName(connection.provider)}
            </span>
            <Badge tone={STATUS_TONE[connection.status]}>
              {t(`tracker.status.${connection.status}`)}
            </Badge>
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {connection.base_url} · {t("tracker.synced")}:{" "}
            {connection.last_synced_at
              ? fullDate(connection.last_synced_at, lang)
              : t("tracker.never")}
          </p>
        </div>
        <Switch
          aria-label={`${t("tracker.enabled")}: ${connection.name}`}
          isSelected={connection.enabled}
          isDisabled={pending}
          onChange={(enabled) =>
            void guard(async () => {
              await trackerApi.update(ws.id, connection.id, { enabled });
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
          {t("tracker.syncNow")}
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
          aria-label={`${t("tracker.disconnect")}: ${connection.name}`}
          isDisabled={pending}
          onPress={remove}
        >
          <Trash2 />
        </Button>
      </div>
      {connection.last_error ? (
        <p className="break-words text-xs text-destructive">
          {t("tracker.error")}: {connection.last_error}
        </p>
      ) : null}
      {connection.push_error ? (
        <p className="break-words text-xs text-destructive">
          {t("tracker.pushError", { message: connection.push_error })}
        </p>
      ) : null}
      {connection.pending_pushes ? (
        <p className="text-xs text-muted-foreground">
          {t("tracker.pendingPushes", { count: connection.pending_pushes })}
        </p>
      ) : null}
      {connection.projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("tracker.unfinished")}</p>
      ) : null}
      <FormError>{error}</FormError>
    </li>
  );
}
