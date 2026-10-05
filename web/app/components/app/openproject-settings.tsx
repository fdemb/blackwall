import { useState } from "react";
import { Form } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { EmptyState } from "./page";
import { SettingsList, SettingsSection } from "./settings";
import { ConfirmDialog } from "./confirm";
import { NullableSelect } from "./pickers";
import { useI18n } from "~/lib/i18n";
import { fullDate } from "~/lib/format";
import { useWorkspace } from "~/lib/workspace";
import { usePending } from "~/lib/use-pending";
import { useToast } from "~/components/ui/toast";
import { openproject, openprojectKey, openprojectQuery } from "~/lib/openproject";
import type { OpenProjectConnection, OpenProjectMapping } from "~/lib/types";

type Editor = { kind: "create" } | { kind: "edit"; connection: OpenProjectConnection };

export function OpenProjectSettings() {
  const { ws, canAdmin } = useWorkspace();
  const { t } = useI18n();
  const client = useQueryClient();
  const query = useQuery({ ...openprojectQuery(ws.id), enabled: canAdmin });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState<OpenProjectConnection | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: openprojectKey(ws.id) });
  if (!canAdmin) return null;
  return (
    <SettingsSection
      title={t("openproject.title")}
      description={t("openproject.description")}
      actions={
        <Button size="sm" onPress={() => setEditor({ kind: "create" })}>
          <Plus />
          {t("openproject.add")}
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
          <p>{t("openproject.loadError")}</p>
          <Button size="sm" variant="ghost" onPress={() => void query.refetch()}>
            {t("openproject.retry")}
          </Button>
        </div>
      ) : null}
      {query.data?.connections.length === 0 ? (
        <EmptyState
          icon={<Plug />}
          title={t("openproject.empty")}
          description={t("openproject.emptySub")}
        />
      ) : null}
      <SettingsList>
        {query.data?.connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            refresh={refresh}
            edit={() => setEditor({ kind: "edit", connection })}
            remove={() => setRemoving(connection)}
          />
        ))}
      </SettingsList>
      <Dialog
        title={t(editor?.kind === "edit" ? "openproject.edit" : "openproject.add")}
        isOpen={editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        {(close) => editor && <ConnectionForm editor={editor} close={close} refresh={refresh} />}
      </Dialog>
      <ConfirmDialog
        title={t("openproject.remove")}
        description={t("openproject.removeSub")}
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await openproject.remove(ws.id, removing.id);
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
  connection: OpenProjectConnection;
  refresh: () => Promise<void>;
  edit: () => void;
  remove: () => void;
}) {
  const { ws } = useWorkspace();
  const { t, lang } = useI18n();
  const { pending, error, guard } = usePending();
  const toast = useToast();
  const queue = (kind: "refresh" | "sync") =>
    guard(async () => {
      await openproject[kind](ws.id, connection.id);
      toast.show(t("openproject.queued"));
      await refresh();
    });
  return (
    <li className="space-y-3 py-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium">{connection.name}</p>
          <p className="break-all text-xs text-muted-foreground">{connection.base_url}</p>
        </div>
        <Switch
          aria-label={`${t("openproject.enabled")}: ${connection.name}`}
          isSelected={connection.enabled}
          isDisabled={pending}
          onChange={(enabled) =>
            void guard(async () => {
              await openproject.update(ws.id, connection.id, { enabled });
              await refresh();
            })
          }
        />
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
          aria-label={`${t("openproject.remove")}: ${connection.name}`}
          isDisabled={pending}
          onPress={remove}
        >
          <Trash2 />
        </Button>
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">{t("openproject.status")}: </dt>
          <dd className="inline">{t(`openproject.status.${connection.status}`)}</dd>
        </div>
        <div>
          <dt className="inline">{t("openproject.checked")}: </dt>
          <dd className="inline">
            {connection.last_checked_at
              ? fullDate(connection.last_checked_at, lang)
              : t("openproject.never")}
          </dd>
        </div>
        <div>
          <dt className="inline">{t("openproject.synced")}: </dt>
          <dd className="inline">
            {connection.last_synced_at
              ? fullDate(connection.last_synced_at, lang)
              : t("openproject.never")}
          </dd>
        </div>
      </dl>
      {connection.last_error ? (
        <p className="break-words text-xs text-destructive">
          {t("openproject.error")}: {connection.last_error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" isDisabled={pending} onPress={() => void queue("refresh")}>
          <RefreshCw />
          {t("openproject.refresh")}
        </Button>
        <Button
          size="sm"
          isDisabled={pending || !connection.enabled || connection.projects.length === 0}
          onPress={() => void queue("sync")}
        >
          {t("openproject.sync")}
        </Button>
      </div>
      <FormError>{error}</FormError>
    </li>
  );
}

function ConnectionForm({
  editor,
  close,
  refresh,
}: {
  editor: Editor;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const { ws } = useWorkspace();
  const { t } = useI18n();
  const connection = editor.kind === "edit" ? editor.connection : null;
  const [name, setName] = useState(connection?.name ?? "");
  const [url, setUrl] = useState(connection?.base_url ?? "");
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<OpenProjectMapping[]>(connection?.projects ?? []);
  const { pending, error, guard } = usePending();
  useDialogDirty(
    name !== (connection?.name ?? "") ||
      url !== (connection?.base_url ?? "") ||
      token !== "" ||
      JSON.stringify(projects) !== JSON.stringify(connection?.projects ?? []),
  );
  // Retain mapped projects even if discovery no longer returns them.
  const available = new Map(connection?.cached_projects.map((p) => [p.id, p.name]));
  for (const p of projects)
    if (!available.has(p.project_id)) available.set(p.project_id, String(p.project_id));
  const setTeam = (project_id: number, team_id: string | null) =>
    setProjects((old) => {
      const previous = old.find((p) => p.project_id === project_id);
      const rest = old.filter((p) => p.project_id !== project_id);
      return team_id
        ? [
            ...rest,
            {
              project_id,
              team_id,
              ...(previous?.team_id === team_id && previous.stage_mapping
                ? { stage_mapping: previous.stage_mapping }
                : {}),
            },
          ]
        : rest;
    });
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void guard(async () => {
          if (connection) {
            const body = {
              name: name.trim(),
              base_url: url.trim(),
              projects,
              ...(token ? { token } : {}),
            };
            await openproject.update(ws.id, connection.id, body);
          } else {
            await openproject.create(ws.id, {
              name: name.trim(),
              base_url: url.trim(),
              token,
              projects,
            });
          }
          setToken("");
          await refresh();
          close();
        });
      }}
    >
      <TextField
        label={t("field.name")}
        value={name}
        onChange={setName}
        isRequired
        autoFocus
        autoComplete="off"
        isDisabled={pending}
      />
      <TextField
        label={t("openproject.url")}
        description={t("openproject.urlHint")}
        type="url"
        value={url}
        onChange={setUrl}
        isRequired
        autoComplete="off"
        spellCheck="false"
        isDisabled={pending}
        placeholder="https://"
      />
      <TextField
        label={t("openproject.token")}
        description={t(connection ? "openproject.tokenKeep" : "openproject.tokenHint")}
        type="password"
        value={token}
        onChange={setToken}
        isRequired={!connection}
        autoComplete="new-password"
        spellCheck="false"
        isDisabled={pending}
      />
      {connection ? (
        <fieldset className="space-y-3" disabled={pending}>
          <legend className="text-[13px] font-medium">{t("openproject.projects")}</legend>
          <p className="text-xs text-muted-foreground">{t("openproject.projectsHint")}</p>
          {available.size ? (
            [...available].map(([id, label]) => (
              <NullableSelect
                key={id}
                label={label}
                value={projects.find((p) => p.project_id === id)?.team_id}
                noneLabel={t("openproject.noTeam")}
                isDisabled={pending}
                options={ws.teams.map((team) => ({ id: team.id, label: team.name }))}
                onChange={(team) => setTeam(id, team)}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">{t("openproject.noProjects")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("openproject.automaticStages")}</p>
        </fieldset>
      ) : null}
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close} isDisabled={pending}>
          {t("action.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          isPending={pending}
          isDisabled={!name.trim() || !url.trim() || (!connection && !token.trim())}
        >
          {t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
