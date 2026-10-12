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
import {
  automaticOpenProjectStage,
  migratedOpenProjectStageKind,
  openproject,
  openprojectKey,
  openprojectQuery,
} from "~/lib/openproject";
import type {
  OpenProjectConnection,
  OpenProjectMapping,
  OpenProjectStatus,
  Team,
} from "~/lib/types";

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
        <p role="status" className="px-4 py-5  text-muted-foreground">
          {t("action.loading")}
        </p>
      ) : null}
      {query.isError ? (
        <div role="alert" className="px-4 py-4 ">
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
        size="lg"
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
    <li className="space-y-3 py-4 ">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium">{connection.name}</p>
          <p className="break-all  text-muted-foreground">{connection.base_url}</p>
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
      <dl className="flex flex-wrap gap-x-6 gap-y-1  text-muted-foreground">
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
        <p className="break-words  text-destructive">
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

/**
 * Replaces every status mapped to MIGRATE with a stage of the same name,
 * reusing an existing one or creating it after the team's last stage.
 * `onMapped` reports each resolved id as soon as it exists.
 */
async function migrateStages({
  projects,
  teams,
  statuses,
  createStage,
  onMapped,
  missing,
}: {
  projects: OpenProjectMapping[];
  teams: readonly Team[];
  statuses: readonly OpenProjectStatus[];
  createStage: (
    teamId: string,
    name: string,
    kind: ReturnType<typeof migratedOpenProjectStageKind>,
    position: number,
  ) => Promise<string | null | undefined>;
  onMapped: (projectId: number, statusId: string, stageId: string) => void;
  missing: () => Error;
}): Promise<OpenProjectMapping[]> {
  const resolved: OpenProjectMapping[] = [];
  const created = new Map<string, string>();
  for (const project of projects) {
    const mapping = { ...project, stage_mapping: { ...project.stage_mapping } };
    const team = teams.find((team) => team.id === project.team_id);
    for (const [statusId, stageId] of Object.entries(mapping.stage_mapping)) {
      if (stageId !== MIGRATE) continue;
      const status = statuses.find((status) => String(status.id) === statusId);
      if (!status || !team) throw missing();
      const name = status.name.toLowerCase();
      const key = `${team.id}:${name}`;
      const existing = team.stages.find((stage) => stage.name.toLowerCase() === name);
      const position =
        Math.max(0, ...team.stages.map((stage) => stage.position)) + created.size + 1;
      const id =
        existing?.id ??
        created.get(key) ??
        (await createStage(team.id, status.name, migratedOpenProjectStageKind(status), position));
      if (!id) throw missing();
      created.set(key, id);
      mapping.stage_mapping[statusId] = id;
      onMapped(mapping.project_id, statusId, id);
    }
    resolved.push(mapping);
  }
  return resolved;
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
  const { ws, members, run, confirmed } = useWorkspace();
  const { t } = useI18n();
  const connection = editor.kind === "edit" ? editor.connection : null;
  const [name, setName] = useState(connection?.name ?? "");
  const [url, setUrl] = useState(connection?.base_url ?? "");
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<OpenProjectMapping[]>(connection?.projects ?? []);
  const [people, setPeople] = useState(connection?.people_mapping ?? {});
  const { pending, error, guard } = usePending();
  useDialogDirty(
    name !== (connection?.name ?? "") ||
      url !== (connection?.base_url ?? "") ||
      token !== "" ||
      JSON.stringify(projects) !== JSON.stringify(connection?.projects ?? []) ||
      JSON.stringify(people) !== JSON.stringify(connection?.people_mapping ?? {}),
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
          const resolvedProjects = await migrateStages({
            projects,
            teams: ws.teams,
            statuses: connection?.cached_statuses ?? [],
            createStage: (team_id, name, kind, position) =>
              run({ type: "create_stage", team_id, name, kind, position }, { quiet: true }),
            onMapped: (projectId, statusId, stageId) =>
              setProjects((old) =>
                old.map((project) =>
                  project.project_id === projectId
                    ? {
                        ...project,
                        stage_mapping: { ...project.stage_mapping, [statusId]: stageId },
                      }
                    : project,
                ),
              ),
            missing: () => new Error(t("openproject.migrationMissing")),
          });
          await confirmed(resolvedProjects);
          if (connection) {
            const body = {
              name: name.trim(),
              base_url: url.trim(),
              projects: resolvedProjects,
              people_mapping: people,
              ...(token ? { token } : {}),
            };
            await openproject.update(ws.id, connection.id, body);
          } else {
            await openproject.create(ws.id, {
              name: name.trim(),
              base_url: url.trim(),
              token,
              projects: resolvedProjects,
              people_mapping: people,
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
          <legend className=" font-medium">{t("openproject.projects")}</legend>
          <p className=" text-muted-foreground">{t("openproject.projectsHint")}</p>
          {available.size ? (
            [...available].map(([id, label]) => {
              const mapping = projects.find((project) => project.project_id === id);
              const team = ws.teams.find((team) => team.id === mapping?.team_id);
              return (
                <div key={id} className="space-y-3 border-t border-border pt-3">
                  <NullableSelect
                    label={label}
                    value={mapping?.team_id}
                    noneLabel={t("openproject.noTeam")}
                    isDisabled={pending}
                    options={ws.teams.map((team) => ({ id: team.id, label: team.name }))}
                    onChange={(team) => setTeam(id, team)}
                  />
                  {mapping && team ? (
                    <ProjectStatuses
                      mapping={mapping}
                      team={team}
                      statuses={connection.cached_statuses}
                      pending={pending}
                      onChange={(statusId, stageId) =>
                        setProjects((old) =>
                          old.map((project) => {
                            if (project.project_id !== id) return project;
                            const stage_mapping = { ...project.stage_mapping };
                            if (stageId) stage_mapping[statusId] = stageId;
                            else delete stage_mapping[statusId];
                            return { ...project, stage_mapping };
                          }),
                        )
                      }
                    />
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className=" text-muted-foreground">{t("openproject.noProjects")}</p>
          )}
          <p className=" text-muted-foreground">{t("openproject.automaticStages")}</p>
        </fieldset>
      ) : null}
      {connection ? (
        <fieldset className="space-y-3" disabled={pending}>
          <legend className=" font-medium">{t("openproject.people")}</legend>
          <p className=" text-muted-foreground">{t("openproject.peopleHint")}</p>
          {connection.cached_people
            .filter((person) => !person.email)
            .map((person) => (
              <p key={person.id} className=" text-muted-foreground">
                {t("openproject.hiddenEmail", { name: person.name })}
              </p>
            ))}
          {[
            ...new Set([
              ...connection.cached_people.flatMap((person) => (person.email ? [person.email] : [])),
              ...Object.keys(people),
            ]),
          ].map((email) => {
            const match = members.find((member) => member.email.toLowerCase() === email);
            const options = members.map((member) => ({
              id: member.id,
              label: `${member.display_name} (${member.email})`,
            }));
            const mapped = people[email];
            if (mapped && !members.some((member) => member.id === mapped)) {
              options.push({ id: mapped, label: t("openproject.missingPerson") });
            }
            return (
              <NullableSelect
                key={email}
                label={email}
                value={people[email]}
                noneLabel={
                  match
                    ? t("openproject.automaticPerson", { name: match.display_name })
                    : t("openproject.unassigned")
                }
                options={options}
                isDisabled={pending}
                onChange={(id) =>
                  setPeople((old) => {
                    const next = { ...old };
                    if (id) next[email] = id;
                    else delete next[email];
                    return next;
                  })
                }
              />
            );
          })}
          {connection.cached_people.length === 0 ? (
            <p className=" text-muted-foreground">{t("openproject.noPeople")}</p>
          ) : null}
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

const MIGRATE = "__migrate__";

function ProjectStatuses({
  mapping,
  team,
  statuses,
  pending,
  onChange,
}: {
  mapping: OpenProjectMapping;
  team: Team;
  statuses: OpenProjectStatus[];
  pending: boolean;
  onChange: (statusId: string, stageId: string | null) => void;
}) {
  const { t } = useI18n();
  const available = new Map(statuses.map((status) => [String(status.id), status]));
  for (const id of Object.keys(mapping.stage_mapping ?? {})) {
    if (!available.has(id)) available.set(id, { id: Number(id), name: id, is_closed: false });
  }
  return (
    <details className="">
      <summary className="cursor-pointer font-medium">{t("openproject.statusMappings")}</summary>
      <div className="space-y-3 pt-3">
        <p className=" text-muted-foreground">{t("openproject.migrationHint")}</p>
        {[...available].map(([id, status]) => {
          const automatic = automaticOpenProjectStage(status, team.stages);
          const value = mapping.stage_mapping?.[id];
          const options = team.stages.map((stage) => ({ id: stage.id, label: stage.name }));
          if (value && value !== MIGRATE && !team.stages.some((stage) => stage.id === value)) {
            options.push({ id: value, label: t("openproject.missingStage") });
          }
          if (statuses.some((status) => String(status.id) === id)) {
            options.push({
              id: MIGRATE,
              label: t("openproject.migrateStatus", { name: status.name }),
            });
          }
          return (
            <NullableSelect
              key={id}
              label={status.name}
              value={value}
              noneLabel={t("openproject.automaticStage", {
                name: automatic?.name ?? t("openproject.missingStage"),
              })}
              options={options}
              isDisabled={pending}
              onChange={(stage) => onChange(id, stage)}
            />
          );
        })}
        {available.size === 0 ? (
          <p className=" text-muted-foreground">{t("openproject.noStatuses")}</p>
        ) : null}
      </div>
    </details>
  );
}
