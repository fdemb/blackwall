import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, Navigate, useParams } from "react-router";
import {
  Archive,
  CheckCheck,
  ChevronLeft,
  List,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Target,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { DndColumn } from "~/components/app/board";
import { IssueList } from "~/components/app/issue-list";
import { NullableSelect } from "~/components/app/pickers";
import { EmptyState, Page, PageHeader, Card } from "~/components/app/page";
import { isDone } from "~/lib/filters";
import { fullDate, shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Sprint, Workspace } from "~/lib/types";

const setSprintOptimistic = (ws: Workspace, ids: Id[], sprint: Id | null): Workspace => ({
  ...ws,
  issues: ws.issues.map((i) => (ids.includes(i.id) ? { ...i, sprint_id: sprint } : i)),
});

export default function Sprints() {
  const { t, lang } = useI18n();
  const { teamId, ws: wsId } = useParams();
  const { ws, team, run, canWrite, create } = useWorkspace();
  const tm = team(teamId!);
  const [editing, setEditing] = useState<Sprint | "new" | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [viewing, setViewing] = useState<Sprint | null>(null);
  const { pending: changing, guard } = usePending();
  if (!tm) return <Navigate to={`/${wsId}/my-issues`} replace />;
  const sprints = ws.sprints.filter((s) => s.team_id === tm.id);
  const open = sprints
    .filter((s) => s.state === "active" || s.state === "planned")
    .sort((a, b) =>
      a.state === b.state
        ? +new Date(a.starts_at) - +new Date(b.starts_at)
        : a.state === "active"
          ? -1
          : 1,
    );
  const past = sprints
    .filter((s) => s.state === "completed" || s.state === "archived")
    .sort((a, b) => +new Date(b.ends_at) - +new Date(a.ends_at));
  const teamIssues = ws.issues.filter((i) => i.team_id === tm.id && !i.deleted_at);
  const backlog = teamIssues
    .filter((i) => !i.sprint_id && !isDone(ws, i))
    .sort((a, b) => a.position - b.position);

  const assign = (target: Id | null) => (ids: Id[], _before: Id | null, source: Id | null) => {
    const to = target;
    if (source === (target ?? "backlog")) return;
    for (const id of ids)
      run(
        { type: "update_issue", id, patch: to ? { sprint_id: to } : { clear_sprint: true } },
        { optimistic: (w) => setSprintOptimistic(w, [id], to) },
      ).catch(() => {});
  };

  return (
    <Page>
      <PageHeader
        title={tm.name}
        subtitle={t("team.sprints")}
        icon={
          <Link
            to={`/${ws.id}/team/${tm.id}?layout=board`}
            aria-label={t("action.back")}
            className="-ml-1 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Link>
        }
        actions={
          canWrite && (
            <Button variant="primary" size="sm" onPress={() => setEditing("new")}>
              <Plus />
              {t("sprint.new")}
            </Button>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex min-h-[420px] flex-1 gap-3 overflow-x-auto p-3">
          <DndColumn
            id="backlog"
            title={t("team.backlog")}
            issues={backlog}
            onDrop={assign(null)}
            onCreate={() => create.show({ team_id: tm.id })}
            emptyText={t("sprint.backlogEmpty")}
            className="w-80"
          />
          {open.map((s) => {
            const list = teamIssues
              .filter((i) => i.sprint_id === s.id)
              .sort((a, b) => a.position - b.position);
            const done = list.filter((i) => isDone(ws, i)).length;
            return (
              <DndColumn
                key={s.id}
                id={s.id}
                title={s.name}
                issues={list}
                onDrop={assign(s.id)}
                onCreate={() => create.show({ team_id: tm.id, sprint_id: s.id })}
                className="w-80"
                emptyText={t("sprint.dropHere")}
                aside={
                  <>
                    <Badge tone={s.state === "active" ? "primary" : "neutral"}>
                      {t(`sprint.state.${s.state}`)}
                    </Badge>
                    {canWrite && (
                      <MenuTrigger>
                        <Button variant="ghost" size="icon" aria-label={t("action.more")}>
                          <MoreHorizontal />
                        </Button>
                        <MenuPopover placement="bottom end">
                          <Menu
                            onAction={(k) => {
                              if (k === "edit") setEditing(s);
                              if (k === "start")
                                void guard(() =>
                                  run({
                                    type: "update_sprint",
                                    id: s.id,
                                    name: s.name,
                                    goal: s.goal,
                                    starts_at: s.starts_at,
                                    ends_at: s.ends_at,
                                    state: "active",
                                  }),
                                );
                              if (k === "complete") setCompleting(s);
                            }}
                          >
                            <MenuItem id="edit">
                              <Pencil />
                              {t("action.edit")}
                            </MenuItem>
                            {s.state === "planned" && (
                              <MenuItem id="start" isDisabled={changing}>
                                <Play />
                                {changing ? t("sprint.starting") : t("sprint.start")}
                              </MenuItem>
                            )}
                            {s.state === "active" && (
                              <MenuItem id="complete">
                                <CheckCheck />
                                {t("sprint.complete")}
                              </MenuItem>
                            )}
                          </Menu>
                        </MenuPopover>
                      </MenuTrigger>
                    )}
                  </>
                }
                footer={
                  <div className="space-y-1.5 border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    {s.goal && (
                      <p className="flex gap-1.5 text-foreground">
                        <Target className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        {s.goal}
                      </p>
                    )}
                    <p className="tabular-nums">
                      {shortDate(s.starts_at, lang)} – {shortDate(s.ends_at, lang)} ·{" "}
                      {t("sprint.progress", { done, total: list.length })}
                    </p>
                    <div className="h-1 overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>

        {past.length > 0 && (
          <section className="px-4 pb-8">
            <h2 className="mb-2 text-[13px] font-semibold">{t("sprint.past")}</h2>
            <Card className="divide-y divide-border">
              {past.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]"
                >
                  <span className="font-medium">{s.name}</span>
                  <Badge>{t(`sprint.state.${s.state}`)}</Badge>
                  <span className="text-muted-foreground tabular-nums">
                    {fullDate(s.starts_at, lang)} – {fullDate(s.ends_at, lang)}
                  </span>
                  {s.outcome && (
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      {t("sprint.outcome", {
                        done: s.outcome.completed,
                        total: s.outcome.total,
                        effort: s.outcome.effort,
                      })}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={s.outcome ? "" : "ml-auto"}
                    onPress={() => setViewing(s)}
                  >
                    <List />
                    {t("sprint.viewIssues")}
                  </Button>
                  {canWrite && s.state === "completed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      isDisabled={changing}
                      onPress={() => void guard(() => run({ type: "archive_sprint", id: s.id }))}
                    >
                      <Archive />
                      {t("sprint.archive")}
                    </Button>
                  )}
                </div>
              ))}
            </Card>
          </section>
        )}
      </div>

      <Dialog
        title={editing === "new" ? t("sprint.new") : t("sprint.edit")}
        size="sm"
        isOpen={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        {(close) => (
          <SprintForm teamId={tm.id} sprint={editing === "new" ? null : editing} close={close} />
        )}
      </Dialog>
      <Dialog
        title={t("sprint.issuesTitle", { name: viewing?.name ?? "" })}
        size="lg"
        isOpen={viewing !== null}
        onOpenChange={(o) => !o && setViewing(null)}
      >
        {() =>
          viewing && (
            <div className="-mx-5 -mb-5 max-h-[60vh] overflow-y-auto border-t border-border">
              <IssueList
                issues={teamIssues
                  .filter((i) => i.sprint_id === viewing.id)
                  .sort((a, b) => a.position - b.position)}
                groupBy="stage"
                selectable={false}
                emptyState={<EmptyState title={t("sprint.noIssues")} />}
              />
            </div>
          )
        }
      </Dialog>
      <Dialog
        title={t("sprint.complete")}
        description={completing?.name}
        size="sm"
        isOpen={completing !== null}
        onOpenChange={(o) => !o && setCompleting(null)}
      >
        {(close) => completing && <CompleteForm sprint={completing} close={close} />}
      </Dialog>
    </Page>
  );
}

function SprintForm({
  teamId,
  sprint,
  close,
}: {
  teamId: Id;
  sprint: Sprint | null;
  close: () => void;
}) {
  const t = useI18n().t;
  const { run } = useWorkspace();
  const [name, setName] = useState(sprint?.name ?? "");
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [start, setStart] = useState<string | null>(sprint?.starts_at ?? new Date().toISOString());
  const [end, setEnd] = useState<string | null>(
    sprint?.ends_at ?? new Date(Date.now() + 14 * 86400000).toISOString(),
  );
  const { pending, error, guard } = usePending();
  const reversed = Boolean(start && end && new Date(end) < new Date(start));
  const invalid = !name.trim() || !start || !end || reversed;
  useDialogDirty(
    name !== (sprint?.name ?? "") ||
      goal !== (sprint?.goal ?? "") ||
      start !== (sprint?.starts_at ?? start) ||
      end !== (sprint?.ends_at ?? end),
  );
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
                { quiet: true },
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
        <p role="alert" className="-mt-2 text-xs text-destructive">
          {t("sprint.endBeforeStart")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
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

function CompleteForm({ sprint, close }: { sprint: Sprint; close: () => void }) {
  const t = useI18n().t;
  const { ws, run } = useWorkspace();
  const [target, setTarget] = useState<Id | null>(null);
  const { pending, error, guard } = usePending();
  const unfinished = ws.issues.filter(
    (i) => i.sprint_id === sprint.id && !i.deleted_at && !isDone(ws, i),
  ).length;
  const options = ws.sprints
    .filter(
      (s) =>
        s.team_id === sprint.team_id &&
        s.id !== sprint.id &&
        (s.state === "planned" || s.state === "active"),
    )
    .map((s) => ({ id: s.id, label: s.name }));
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "complete_sprint", id: sprint.id, carryover_sprint_id: target },
            { quiet: true },
          );
          close();
        });
      }}
    >
      <p className="text-[13px] text-muted-foreground">
        {unfinished ? t("sprint.unfinished", { n: unfinished }) : t("sprint.allDone")}
      </p>
      {unfinished > 0 && (
        <NullableSelect
          label={t("sprint.moveTo")}
          noneLabel={t("team.backlog")}
          value={target}
          onChange={setTarget}
          options={options}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
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
