import { useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { DropIndicator, Form, GridList, GridListItem, useDragAndDrop } from "react-aria-components";
import {
  ArrowUpRight,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button, buttonVariants } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, Input, TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Select } from "~/components/ui/select";
import { ConfirmDialog } from "~/components/app/confirm";
import { StageIcon } from "~/components/app/icons";
import { MultiMemberPicker } from "~/components/app/pickers";
import { SaveStatus } from "~/components/app/save-status";
import { SettingsList, SettingsRow, SettingsSection } from "~/components/app/settings";
import { TeamAppearancePicker, TeamColorSwatches, TeamIcon } from "~/components/app/team-icon";
import { ApiError } from "~/lib/api";
import { STAGE_KINDS } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { isTeamKey, teamKeyInput } from "~/lib/identifiers";
import { useStageIssueCounts } from "~/lib/stats";
import {
  archiveChoices,
  reorderStages,
  teamForKeyParam,
  teamView,
  type StageView,
  type TeamView,
} from "~/lib/team-settings";
import { useDocumentTitle } from "~/lib/title";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import { trackerApi } from "~/lib/trackers";
import { useEngine, useView } from "~/sync/react";
import type { Id, Stage, StageKind, Team } from "~/lib/types";

export default function TeamSettings() {
  const { teamKey = "" } = useParams();
  const { ws } = useWorkspace();
  const list = `/${ws.slug}/settings/teams`;
  // A re-key the server rejects rolls back after the URL moved to the new key, which then names no
  // team or another one. Holding the team for the URL it was found under keeps the page on it.
  const [held, setHeld] = useState<{ param: string; id: Id } | null>(null);
  const team =
    held?.param === teamKey
      ? ws.teams.find((candidate) => candidate.id === held.id)
      : teamForKeyParam(ws.teams, teamKey);
  if (!team) return <Navigate to={list} replace />;
  if (held?.param !== teamKey || held.id !== team.id) setHeld({ param: teamKey, id: team.id });
  return (
    <>
      {/* Old keys keep working in links, but the address bar shows the current one. */}
      {team.key !== teamKey && <Navigate to={`${list}/${team.key}`} replace />}
      <TeamDetail key={team.id} team={team} />
    </>
  );
}

function TeamDetail({ team }: { team: Team }) {
  const { canAdmin } = useWorkspace();
  const view = teamView(team, useStageIssueCounts());
  useDocumentTitle(team.name);
  return (
    <div className="space-y-8">
      <Header view={view} />
      <Details team={team} />
      <Workflow view={view} />
      <Members team={team} />
      <AutoArchive team={team} />
      {canAdmin && <DeleteTeam team={team} />}
    </div>
  );
}

function Header({ view: { team, openIssues } }: { view: TeamView }) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  return (
    <header className="space-y-4">
      <nav aria-label={t("team.breadcrumb")} className="flex items-center gap-1.5 font-medium">
        <Link
          to={`/${ws.slug}/settings/teams`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {t("settings.teams")}
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
        <span aria-current="page" className="truncate">
          {team.name}
        </span>
      </nav>
      <div className="flex flex-wrap items-center gap-4">
        <TeamIcon team={team} className="size-12 rounded-xl [&_svg]:size-5.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{team.name}</h1>
            <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground">
              {team.key}
            </span>
          </div>
          <p className="mt-0.5 text-muted-foreground">
            {t("count.members", { count: team.members.length })} ·{" "}
            {t("team.openIssues", { count: openIssues })}
          </p>
        </div>
        <SaveStatus />
        <Link
          to={`/${ws.slug}/team/${team.key}/board`}
          className={buttonVariants({ variant: "secondary", size: "md" })}
        >
          {t("team.openBoard")}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </header>
  );
}

function Details({ team }: { team: Team }) {
  const { t } = useI18n();
  const { run, canAdmin } = useWorkspace();
  return (
    <SettingsSection title={t("team.details")}>
      <div className="divide-y divide-border">
        <SettingsRow label={t("field.name")} description={t("team.nameSub")}>
          <NameField team={team} />
        </SettingsRow>
        <KeyRow team={team} />
        <SettingsRow label={t("team.appearance")} description={t("team.appearanceSub")}>
          <div className="flex w-full items-center gap-2 sm:w-70">
            <TeamAppearancePicker
              team={team}
              isDisabled={!canAdmin}
              onChange={(appearance) =>
                run({ type: "set_team_appearance", id: team.id, ...appearance }).catch(() => {})
              }
            />
            <TeamColorSwatches
              value={team.color}
              isDisabled={!canAdmin}
              onChange={(color) =>
                run({ type: "set_team_appearance", id: team.id, icon: team.icon, color }).catch(
                  () => {},
                )
              }
              className="ml-auto flex flex-wrap justify-end gap-0.5"
            />
          </div>
        </SettingsRow>
      </div>
    </SettingsSection>
  );
}

function NameField({ team }: { team: Team }) {
  const { t } = useI18n();
  const { run, canAdmin } = useWorkspace();
  // While focused, the field keeps what the user types and the name it started from; otherwise it
  // shows the team's current name, so a rename from elsewhere never gets written back.
  const [draft, setDraft] = useState<{ from: string; name: string } | null>(null);
  const commit = () => {
    if (!draft) return;
    setDraft(null);
    const next = draft.name.trim();
    if (!next || next === draft.from || next === team.name) return;
    run({ type: "update_team", id: team.id, name: next, key: team.key }).catch(() => {});
  };
  return (
    <Input
      aria-label={t("field.name")}
      value={draft?.name ?? team.name}
      disabled={!canAdmin}
      onFocus={() => setDraft({ from: team.name, name: team.name })}
      onChange={(e) => setDraft({ from: draft?.from ?? team.name, name: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft({ from: team.name, name: team.name });
      }}
      className="w-full sm:w-70"
    />
  );
}

/** Re-keying is a deliberate step, so it waits for Save and says what happens to the old key. */
function KeyRow({ team }: { team: Team }) {
  const { t } = useI18n();
  const { run, canAdmin, ws } = useWorkspace();
  const [key, setKey] = useState(team.key);
  const { pending, error, guard } = usePending();
  const taken = new Set(
    ws.teams.filter((other) => other.id !== team.id).flatMap((o) => [o.key, ...o.former_keys]),
  );
  const changed = key !== team.key;
  const problem = !changed
    ? ""
    : !isTeamKey(key)
      ? t("team.keyInvalid")
      : taken.has(key)
        ? t("team.keyTaken")
        : "";
  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !problem)
          void guard(() =>
            run({ type: "update_team", id: team.id, name: team.name, key }, { quiet: true }),
          );
      }}
    >
      <SettingsRow
        label={t("team.key")}
        description={
          <>
            {t("team.keyHint", { example: `${key || team.key}-42` })}
            {changed && !problem && (
              <span className="mt-2 flex gap-1.5 text-foreground">
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {t("team.rekeyWarning")}
              </span>
            )}
          </>
        }
      >
        <div className="flex w-full flex-col gap-1 sm:w-70">
          <div className="flex gap-2">
            <Input
              aria-label={t("team.key")}
              value={key}
              disabled={!canAdmin}
              onChange={(e) => setKey(teamKeyInput(e.target.value))}
              onKeyDown={(e) => e.key === "Escape" && setKey(team.key)}
              autoComplete="off"
              spellCheck="false"
              className="min-w-0 flex-1 font-mono"
            />
            {changed && (
              <Button type="submit" variant="primary" isDisabled={Boolean(problem) || pending}>
                {pending ? t("action.saving") : t("action.save")}
              </Button>
            )}
          </div>
          <FormError>{problem || error}</FormError>
        </div>
      </SettingsRow>
    </Form>
  );
}

function Workflow({ view }: { view: TeamView }) {
  const { t } = useI18n();
  const { run, canAdmin } = useWorkspace();
  const { store } = useEngine();
  const { team } = view;
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  // Rows drag from anywhere, which would steal text selection from the name field while it edits.
  const [editing, setEditing] = useState<Id | null>(null);
  const { guard } = usePending();
  const rows = view.stages.map((row) => ({ id: row.stage.id, ...row }));
  const move = (moved: Id, target: Id, side: "before" | "after") =>
    guard(async () => {
      for (const { stage, position } of reorderStages(team.stages, moved, target, side)) {
        // Earlier sends and other admins may have changed the stage since the drop.
        const current = store.get("teams", team.id)?.stages.find((s) => s.id === stage.id);
        if (!current) continue;
        await run({
          type: "update_stage",
          team_id: team.id,
          id: current.id,
          name: current.name,
          kind: current.kind,
          position,
        });
      }
    });
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: !canAdmin || editing !== null,
    getItems: (keys) =>
      [...keys].map((k) => ({
        "text/plain": team.stages.find((s) => s.id === k)?.name ?? "",
      })),
    onReorder: (e) => {
      const [moved] = [...e.keys];
      if (moved === undefined || e.target.dropPosition === "on") return;
      void move(String(moved), String(e.target.key), e.target.dropPosition);
    },
    renderDropIndicator: (target) => (
      <DropIndicator target={target} className="outline-primary drop-target:outline-2" />
    ),
  });
  return (
    <SettingsSection title={t("team.workflow")} description={t("team.workflowSub")}>
      <GridList
        aria-label={t("team.workflow")}
        items={rows}
        selectionMode="none"
        keyboardNavigationBehavior="tab"
        dragAndDropHooks={dragAndDropHooks}
        dependencies={[editing]}
        className="py-1.5 outline-none"
      >
        {(row) => (
          <StageRow
            row={row}
            team={team}
            editing={editing === row.id}
            onEditing={(on) => setEditing(on ? row.id : null)}
            canDelete={team.stages.length > 1}
            onDelete={() => setDeleting(row.stage)}
          />
        )}
      </GridList>
      {canAdmin && (
        <div className="border-t border-border px-3 py-2 sm:px-4">
          <Button variant="ghost" size="sm" onPress={() => setAdding(true)}>
            <Plus />
            {t("stage.add")}
          </Button>
        </div>
      )}
      <Dialog title={t("stage.add")} size="sm" isOpen={adding} onOpenChange={setAdding}>
        {(close) => <AddStage team={team} close={close} />}
      </Dialog>
      <Dialog
        title={t("stage.delete")}
        description={deleting ? t("stage.deleteSub", { name: deleting.name }) : ""}
        size="sm"
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        {(close) => deleting && <DeleteStage team={team} stage={deleting} close={close} />}
      </Dialog>
    </SettingsSection>
  );
}

function StageRow({
  row: { stage, issues },
  team,
  editing,
  onEditing,
  canDelete,
  onDelete,
}: {
  row: StageView & { id: Id };
  team: Team;
  editing: boolean;
  onEditing: (on: boolean) => void;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { run, canAdmin } = useWorkspace();
  // Finishing a rename from the keyboard puts focus back on the name, which replaces the input.
  const [refocus, setRefocus] = useState(false);
  const save = (patch: { name?: string; kind?: StageKind }) =>
    run({
      type: "update_stage",
      team_id: team.id,
      id: stage.id,
      name: (patch.name ?? stage.name).trim(),
      kind: patch.kind ?? stage.kind,
      position: stage.position,
    }).catch(() => {});
  return (
    <GridListItem
      id={stage.id}
      textValue={stage.name}
      className="flex items-center gap-2 px-2 py-1 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 dragging:opacity-50 sm:px-3"
    >
      {canAdmin && (
        <Button
          slot="drag"
          variant="ghost"
          size="icon"
          aria-label={t("stage.reorder", { name: stage.name })}
          className="w-5 cursor-grab"
        >
          <GripVertical className="size-3.5" />
        </Button>
      )}
      <StageIcon kind={stage.kind} className="mx-1" />
      {editing ? (
        <StageNameInput
          stage={stage}
          onDone={(name, keyboard) => {
            setRefocus(keyboard);
            onEditing(false);
            if (name && name !== stage.name) void save({ name });
          }}
        />
      ) : canAdmin ? (
        <Button
          autoFocus={refocus}
          variant="ghost"
          aria-label={t("stage.rename", { name: stage.name })}
          onPress={() => onEditing(true)}
          className="min-w-0 flex-1 justify-start px-2 font-normal text-foreground"
        >
          <span className="truncate">{stage.name}</span>
        </Button>
      ) : (
        <span className="min-w-0 flex-1 truncate px-2">{stage.name}</span>
      )}
      <span className="hidden shrink-0 text-right tabular-nums text-muted-foreground sm:block">
        {t("count.issues", { count: issues })}
      </span>
      <Select
        aria-label={t("team.stageKind", { name: stage.name })}
        className="w-32 shrink-0 sm:w-36"
        isDisabled={!canAdmin}
        selectedKey={stage.kind}
        onSelectionChange={(k) => void save({ kind: k as StageKind })}
        options={STAGE_KINDS.map((k) => ({
          id: k,
          label: t(`stage.kind.${k}`),
          icon: <StageIcon kind={k} />,
        }))}
      />
      {canAdmin && (
        <MenuTrigger>
          <Button variant="ghost" size="icon" aria-label={t("stage.actions", { name: stage.name })}>
            <MoreHorizontal />
          </Button>
          <MenuPopover placement="bottom end">
            <Menu>
              <MenuItem id="delete" isDisabled={!canDelete} onAction={onDelete}>
                {t("stage.delete")}
              </MenuItem>
            </Menu>
          </MenuPopover>
        </MenuTrigger>
      )}
    </GridListItem>
  );
}

function StageNameInput({
  stage,
  onDone,
}: {
  stage: Stage;
  onDone: (name: string, keyboard: boolean) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(stage.name);
  const finished = useRef(false);
  const finish = (value: string, keyboard = false) => {
    if (finished.current) return;
    finished.current = true;
    onDone(value, keyboard);
  };
  return (
    <Input
      aria-label={t("stage.name")}
      value={name}
      autoFocus
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(name.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(name.trim(), true);
        if (e.key === "Escape") finish(stage.name, true);
      }}
      className="min-w-0 flex-1 bg-card"
    />
  );
}

function AddStage({ team, close }: { team: Team; close: () => void }) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StageKind>("active");
  const position = Math.max(0, ...team.stages.map((s) => s.position)) + 1;
  const { pending, error, guard } = usePending();
  useDialogDirty(name !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "create_stage", team_id: team.id, name: name.trim(), kind, position },
            { quiet: true },
          );
          close();
        });
      }}
    >
      <TextField label={t("stage.name")} value={name} onChange={setName} autoFocus isRequired />
      <Select
        label={t("stage.kind")}
        selectedKey={kind}
        onSelectionChange={(k) => setKind(k as StageKind)}
        options={STAGE_KINDS.map((k) => ({
          id: k,
          label: t(`stage.kind.${k}`),
          icon: <StageIcon kind={k} />,
        }))}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim() || pending}>
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}

function DeleteStage({ team, stage, close }: { team: Team; stage: Stage; close: () => void }) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const others = team.stages.filter((s) => s.id !== stage.id);
  const [replacement, setReplacement] = useState<Id | undefined>(others[0]?.id);
  const { pending, error, guard } = usePending();
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (replacement)
          void guard(async () => {
            await run(
              { type: "delete_stage", team_id: team.id, id: stage.id, replacement },
              { quiet: true, expectedVersions: error ? undefined : { [stage.id]: stage.version } },
            );
            close();
          });
      }}
    >
      <Select
        label={t("stage.moveTo")}
        selectedKey={replacement}
        onSelectionChange={(k) => setReplacement(k as Id)}
        options={others.map((s) => ({
          id: s.id,
          label: s.name,
          icon: <StageIcon kind={s.kind} />,
        }))}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="destructive" isDisabled={!replacement || pending}>
          {t("action.delete")}
        </Button>
      </div>
    </Form>
  );
}

function Members({ team }: { team: Team }) {
  const { t } = useI18n();
  const { run, canAdmin, member } = useWorkspace();
  const setMembers = (members: Id[]) =>
    run({ type: "set_team_members", id: team.id, members }).catch(() => {});
  const people = team.members.flatMap((id) => {
    const m = member(id);
    return m ? [m] : [];
  });
  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          {t("team.members")}
          <span className="rounded-full bg-secondary px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
            {people.length}
          </span>
        </span>
      }
      actions={
        canAdmin && (
          <MultiMemberPicker
            value={team.members}
            onChange={setMembers}
            trigger={
              <Button variant="secondary" size="sm">
                <Plus />
                {t("team.addPeople")}
              </Button>
            }
          />
        )
      }
    >
      {people.length === 0 ? (
        <p className="px-4 py-4 text-muted-foreground sm:px-5">{t("team.noMembers")}</p>
      ) : (
        <SettingsList>
          {people.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-3">
              <Avatar name={m.display_name} src={m.avatar_url} size={28} />
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="truncate font-medium">{m.display_name}</span>
                <span className="truncate text-muted-foreground">{m.email}</span>
              </span>
              {canAdmin && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("team.removeMember", { name: m.display_name })}
                  onPress={() => void setMembers(team.members.filter((id) => id !== m.id))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  );
}

function AutoArchive({ team }: { team: Team }) {
  const { t } = useI18n();
  const { run, canAdmin } = useWorkspace();
  const options = archiveChoices(team.archive_after_days).map((days) => ({
    id: days === null ? "never" : String(days),
    label: days === null ? t("team.archiveNever") : t("team.archiveAfter", { count: days }),
  }));
  return (
    <SettingsSection title={t("team.archive")}>
      <SettingsRow label={t("team.archiveDone")} description={t("team.archiveSub")}>
        <Select
          aria-label={t("team.archiveDone")}
          className="w-full sm:w-45"
          isDisabled={!canAdmin}
          selectedKey={team.archive_after_days === null ? "never" : String(team.archive_after_days)}
          onSelectionChange={(k) => {
            if (k === null) return;
            run({
              type: "set_team_archive",
              id: team.id,
              archive_after_days: k === "never" ? null : Number(k),
            }).catch(() => {});
          }}
          options={options}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function DeleteTeam({ team }: { team: Team }) {
  const { t } = useI18n();
  const { run, ws, offline } = useWorkspace();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  // Archived and trashed issues count too, as they do on the server.
  const hasIssues = useView(
    (store) => store.byIndex("issues", "team_id", team.id).length > 0,
    ["issues"],
    [team.id],
  );
  const remove = async () => {
    try {
      await run({ type: "delete_team", id: team.id }, { quiet: true });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      // The server reports issues first, so the tracker is the cause only when there are none.
      const imported =
        !hasIssues &&
        (await trackerApi.list(ws.id).then(
          ({ connections }) =>
            connections.some((c) => c.projects.some((mapping) => mapping.team_id === team.id)),
          () => false,
        ));
      throw new Error(imported ? t("team.deleteImported") : t("team.deleteHasIssues"));
    }
    void navigate(`/${ws.slug}/settings/teams`, { replace: true });
  };
  return (
    <SettingsSection>
      <SettingsRow label={t("team.delete")} description={t("team.deleteSub")}>
        <Button
          variant="secondary"
          className="text-destructive"
          isDisabled={offline}
          onPress={() => setConfirming(true)}
        >
          {t("team.delete")}
        </Button>
      </SettingsRow>
      <ConfirmDialog
        title={t("team.deleteConfirm", { name: team.name })}
        description={t("team.deleteConfirmSub")}
        confirmLabel={t("team.delete")}
        isOpen={confirming}
        onOpenChange={setConfirming}
        onConfirm={remove}
      />
    </SettingsSection>
  );
}
