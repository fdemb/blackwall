import { useState } from "react";
import { Link } from "react-router";
import { Form } from "react-aria-components";
import { Archive, CheckCheck, MoreHorizontal, Pencil, Play } from "lucide-react";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { OPEN, whereIs } from "~/lib/filters";
import { sprintLabel } from "~/lib/format";
import { sprintPath } from "~/lib/last-view";
import { useI18n } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { usePending } from "~/lib/use-pending";
import { useSprintProgress } from "~/lib/stats";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Sprint } from "~/lib/types";
import { NullableSelect } from "./pickers";
import { QueryStatus } from "./query-status";

/**
 * Start, archive, and the edit and complete dialogs for one sprint. The header buttons and the
 * index menu share it, so both offer the same actions for a state.
 */
function useSprintCommands(sprint: Sprint) {
  const { t } = useI18n();
  const { run, ws } = useWorkspace();
  const [dialog, setDialog] = useState<"edit" | "complete" | null>(null);
  const { pending, guard } = usePending();
  const start = () =>
    void guard(() =>
      run({
        type: "update_sprint",
        id: sprint.id,
        name: sprint.name,
        goal: sprint.goal,
        starts_at: sprint.starts_at,
        ends_at: sprint.ends_at,
        state: "active",
      }),
    );
  const archive = () => void guard(() => run({ type: "archive_sprint", id: sprint.id }));
  // A team runs one sprint at a time, so a planned sprint waits for the active one.
  const blocker = ws.sprints.find(
    (s) => s.team_id === sprint.team_id && s.id !== sprint.id && s.state === "active",
  );
  const dialogs = (
    <>
      <Dialog
        title={t("sprint.edit")}
        size="sm"
        isOpen={dialog === "edit"}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        {(close) => <SprintForm teamId={sprint.team_id} sprint={sprint} close={close} />}
      </Dialog>
      <Dialog
        title={t("sprint.complete")}
        description={sprint.name}
        size="sm"
        isOpen={dialog === "complete"}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        {(close) => <CompleteForm sprint={sprint} close={close} />}
      </Dialog>
    </>
  );
  return {
    pending,
    blocker,
    start,
    archive,
    edit: () => setDialog("edit"),
    complete: () => setDialog("complete"),
    dialogs,
  };
}

/** What a sprint's state allows next, as header buttons: edit, then start, complete or archive. */
export function SprintActions({ sprint }: { sprint: Sprint }) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  const { pending, blocker, start, archive, edit, complete, dialogs } = useSprintCommands(sprint);
  if (!canWrite) return null;
  return (
    <>
      {sprint.state !== "archived" && (
        <Button variant="ghost" size="sm" onPress={edit}>
          <Pencil aria-hidden />
          {t("action.edit")}
        </Button>
      )}
      {sprint.state === "planned" && blocker && <ActiveSprintNote sprint={blocker} />}
      {sprint.state === "planned" && (
        <Button variant="primary" size="sm" isDisabled={pending || !!blocker} onPress={start}>
          <Play aria-hidden />
          {pending ? t("sprint.starting") : t("sprint.start")}
        </Button>
      )}
      {sprint.state === "active" && (
        <Button variant="primary" size="sm" onPress={complete}>
          <CheckCheck aria-hidden />
          {t("sprint.complete")}
        </Button>
      )}
      {sprint.state === "completed" && (
        <Button size="sm" isDisabled={pending} onPress={archive}>
          <Archive aria-hidden />
          {t("sprint.archive")}
        </Button>
      )}
      {dialogs}
    </>
  );
}

/** Why a planned sprint can't start yet, with a link to the team's active sprint. */
function ActiveSprintNote({ sprint }: { sprint: Sprint }) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  const team = ws.teams.find((tm) => tm.id === sprint.team_id);
  if (!team) return null;
  return (
    <span className="text-muted-foreground">
      {t("sprint.otherActive")}{" "}
      <Link
        to={sprintPath(ws.slug, team.key, sprint)}
        className="font-medium text-foreground hover:underline"
      >
        {sprintLabel(sprint)}
      </Link>
    </span>
  );
}

/** The same actions as `SprintActions`, folded into a menu for list rows. */
export function SprintMenu({ sprint, className }: { sprint: Sprint; className?: string }) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  const { pending, blocker, start, archive, edit, complete, dialogs } = useSprintCommands(sprint);
  if (!canWrite || sprint.state === "archived") return null;
  return (
    <>
      <MenuTrigger>
        <Button variant="ghost" size="icon" aria-label={t("action.more")} className={className}>
          <MoreHorizontal />
        </Button>
        <MenuPopover placement="bottom end">
          <Menu
            onAction={(k) => {
              if (k === "edit") edit();
              if (k === "start") start();
              if (k === "complete") complete();
              if (k === "archive") archive();
            }}
          >
            <MenuItem id="edit">
              <Pencil />
              {t("action.edit")}
            </MenuItem>
            {sprint.state === "planned" && (
              <MenuItem id="start" isDisabled={pending || !!blocker}>
                <Play />
                {pending ? t("sprint.starting") : t("sprint.start")}
              </MenuItem>
            )}
            {sprint.state === "active" && (
              <MenuItem id="complete">
                <CheckCheck />
                {t("sprint.complete")}
              </MenuItem>
            )}
            {sprint.state === "completed" && (
              <MenuItem id="archive" isDisabled={pending}>
                <Archive />
                {t("sprint.archive")}
              </MenuItem>
            )}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      {dialogs}
    </>
  );
}

export function SprintForm({
  teamId,
  sprint,
  close,
}: {
  teamId: Id;
  sprint: Sprint | null;
  close: () => void;
}) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const [name, setName] = useState(sprint?.name ?? "");
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [start, setStart] = useState<string | null>(sprint?.starts_at ?? new Date().toISOString());
  const [end, setEnd] = useState<string | null>(() => defaultSprintEnd(sprint, start));
  const { pending, error, guard } = usePending();
  const reversed = Boolean(start && end && new Date(end) < new Date(start));
  const invalid = !name.trim() || !start || !end || reversed;
  useDialogDirty(isSprintDirty(sprint, { name, goal, start, end }));
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        const body = { name: name.trim(), goal: goal.trim(), starts_at: start!, ends_at: end! };
        void guard(async () => {
          await (sprint
            ? run(
                { type: "update_sprint", id: sprint.id, state: sprint.state, ...body },
                {
                  quiet: true,
                  expectedVersions: error ? undefined : { [sprint.id]: sprint.version },
                },
              )
            : run({ type: "create_sprint", team_id: teamId, ...body }, { quiet: true }));
          close();
        });
      }}
    >
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      <TextField
        label={t("sprint.goal")}
        value={goal}
        onChange={setGoal}
        multiline
        rows={2}
        placeholder={t("sprint.goalPlaceholder")}
      />
      <div className="grid grid-cols-2 gap-3">
        <DatePicker
          label={t("sprint.starts")}
          value={start}
          onChange={setStart}
          clearable={false}
          endOfDay={false}
        />
        <DatePicker
          label={t("sprint.ends")}
          value={end}
          onChange={setEnd}
          clearable={false}
          isInvalid={reversed}
        />
      </div>
      {reversed && (
        <p role="alert" className="-mt-2  text-destructive">
          {t("sprint.endBeforeStart")}
        </p>
      )}
      {error && (
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={invalid || pending}>
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}

function defaultSprintEnd(sprint: Sprint | null, start: string | null): string | null {
  return (
    sprint?.ends_at ??
    (start ? new Date(new Date(start).getTime() + 14 * 86400000).toISOString() : null)
  );
}

function isSprintDirty(
  sprint: Sprint | null,
  draft: { name: string; goal: string; start: string | null; end: string | null },
): boolean {
  return (
    draft.name !== (sprint?.name ?? "") ||
    draft.goal !== (sprint?.goal ?? "") ||
    draft.start !== (sprint?.starts_at ?? draft.start) ||
    draft.end !== (sprint?.ends_at ?? draft.end)
  );
}

function CompleteForm({ sprint, close }: { sprint: Sprint; close: () => void }) {
  const { t } = useI18n();
  const { ws, run } = useWorkspace();
  const [target, setTarget] = useState<Id | null>(null);
  const { pending, error, guard } = usePending();
  const query = useIssues({ where: [whereIs("sprint_id", sprint.id), OPEN] });
  const stats = useSprintProgress().get(sprint.id);
  const unfinished = (stats?.total ?? 0) - (stats?.completed ?? 0);
  const options = ws.sprints
    .filter(
      (s) =>
        s.team_id === sprint.team_id &&
        s.id !== sprint.id &&
        (s.state === "planned" || s.state === "active"),
    )
    .map((s) => ({ id: s.id, label: sprintLabel(s) }));
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "complete_sprint", id: sprint.id, carryover_sprint_id: target },
            { quiet: true, expectedVersions: error ? undefined : { [sprint.id]: sprint.version } },
          );
          close();
        });
      }}
    >
      <QueryStatus query={query} />
      <p className=" text-muted-foreground">
        {unfinished ? t("sprint.unfinished", { count: unfinished }) : t("sprint.allDone")}
      </p>
      {unfinished > 0 && (
        <NullableSelect
          label={t("sprint.moveTo")}
          noneLabel={t("sprint.none")}
          value={target}
          onChange={setTarget}
          options={options}
        />
      )}
      {error && (
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={pending}>
          {t("sprint.complete")}
        </Button>
      </div>
    </Form>
  );
}
