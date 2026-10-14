import { lazy, Suspense, useRef, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { Link, useNavigate } from "react-router";
import {
  CalendarDays,
  Ellipsis,
  FolderKanban,
  Gauge,
  IterationCw,
  Loader2,
  Paperclip,
  Tag,
  User,
  X,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Tip } from "~/components/ui/tooltip";
import { useToast } from "~/components/ui/toast";
import { bytes, MAX_UPLOAD, PRIORITIES, sprintLabel } from "~/lib/format";
import { usePending } from "~/lib/use-pending";
import { useI18n } from "~/lib/i18n";
import { sprintStageId } from "~/lib/teams";
import { useWorkspace } from "~/lib/workspace";
import type { Id, IssueInput, Priority, Project, Sprint, Stage, Team } from "~/lib/types";
import type { MarkdownEditorHandle } from "./editor/rich-editor";
import { PriorityIcon, StageIcon } from "./icons";
import { ESTIMATES } from "./issue-menus";
import { LabelDot, LabelsPicker } from "./pickers";
import { ChoicePill, DatePill, Pill } from "./property-pills";
import { TeamIcon } from "./team-icon";
// Loaded on demand: the editor is the heaviest part of this dialog.
const MarkdownEditor = lazy(() =>
  import("./editor/rich-editor").then((m) => ({ default: m.MarkdownEditor })),
);

/** Properties tucked behind the "more" pill until they have a value. */
type Extra = "project" | "sprint" | "deadline" | "estimate";

export function CreateIssueDialog() {
  const { create } = useWorkspace();
  const { t } = useI18n();
  return (
    <Dialog
      title={t("issue.new")}
      size="lg"
      position="top"
      isOpen={create.open}
      onOpenChange={(o) => !o && create.hide()}
    >
      {() => <CreateIssueForm />}
    </Dialog>
  );
}

function CreateIssueForm() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const { ws, me, create, run, upload, offline, issueRef } = useWorkspace();
  const d = create.defaults;
  const [teamId, setTeamId] = useState<Id | undefined>(() => defaultTeamId(ws.teams, me, d));
  const team = ws.teams.find((x) => x.id === teamId);
  const [stageId, setStageId] = useState<Id | null>(d.stage_id ?? null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>(d.priority ?? "none");
  const [assignee, setAssignee] = useState<Id | null>(d.assignee ?? null);
  const [labels, setLabels] = useState<Id[]>(d.labels ?? []);
  const [projectId, setProjectId] = useState<Id | null>(d.project_id ?? null);
  const [sprintId, setSprintId] = useState<Id | null>(d.sprint_id ?? null);
  const [parentId] = useState<Id | null>(d.parent_id ?? null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const editor = useRef<MarkdownEditorHandle>(null);
  const { pending, error, guard } = usePending();
  useDialogDirty(title.trim() !== "" || description !== "" || files.length > 0);

  // The picker always shows a stage from the current team. A stale choice, from the defaults or a
  // previous team, falls back to the team's default stage.
  const effectiveStageId = resolveStageId(team, stageId, sprintId);
  // Backlog issues have no sprint. Picking one side gives way on the other, as the server would.
  const inBacklog = (id: Id | null) => team?.stages.find((s) => s.id === id)?.kind === "backlog";
  const pickStage = (id: Id | null) => {
    setStageId(id);
    if (inBacklog(id)) setSprintId(null);
  };
  const pickSprint = (id: Id | null) => {
    setSprintId(id);
    if (id && inBacklog(effectiveStageId)) setStageId(null);
  };

  if (ws.teams.length === 0) return <NeedTeam wsSlug={ws.slug} onNavigate={create.hide} />;

  const sprints = ws.sprints.filter(
    (s) => s.team_id === teamId && (s.state === "planned" || s.state === "active"),
  );
  const projects = ws.projects.filter(
    (p) => !teamId || p.team_ids.length === 0 || p.team_ids.includes(teamId),
  );

  // Repeated Ctrl+Enter presses hit the guard, so one submission can't create two issues.
  const submit = () =>
    guard(async () => {
      if (!title.trim() || !teamId) return;
      const input: IssueInput = {
        title: title.trim(),
        description,
        team_id: teamId,
        stage_id: effectiveStageId,
        assignee,
        priority,
        labels,
        estimate,
        deadline,
        project_id: projectId,
        sprint_id: sprintId,
        parent_id: parentId,
      };
      const id = await run({ type: "create_issue", input }, { quiet: true });
      // The issue exists from here on, so a failed upload must not reopen the form and invite a duplicate.
      const failed: File[] = [];
      if (id)
        for (const file of files)
          await upload(id, file, { quiet: true }).catch(() => failed.push(file));
      create.hide();
      toast.show(t("issue.created"));
      if (failed.length)
        toast.error(
          t("attachments.partial", {
            n: failed.length,
            total: files.length,
            names: failed.map((f) => f.name).join(", "),
          }),
        );
      if (id) void nav(`/${ws.slug}/issue/${issueRef(id)}`);
    });
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const ok = Array.from(list).filter((f) => {
      if (f.size <= MAX_UPLOAD) return true;
      toast.error(t("attachments.tooLarge", { name: f.name }));
      return false;
    });
    setFiles((l) => [...l, ...ok]);
  };

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col"
    >
      <input
        autoFocus
        aria-label={t("field.title")}
        placeholder={t("issue.titlePlaceholder")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          // Enter moves on to the description, as in a document. Ctrl/Cmd+Enter submits.
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) void submit();
          else editor.current?.focus();
        }}
        maxLength={200}
        className="w-full bg-transparent text-xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60"
      />
      <div className="mt-2 min-h-32">
        <Suspense
          fallback={
            <p aria-busy className="py-px text-[14px] leading-6 text-muted-foreground/70">
              {t("issue.descriptionPlaceholder")}
            </p>
          }
        >
          <MarkdownEditor
            ref={editor}
            label={t("field.description")}
            value={description}
            onChange={setDescription}
            placeholder={t("issue.descriptionPlaceholder")}
            appearance="plain"
            className="min-h-32"
            onSubmit={submit}
          />
        </Suspense>
      </div>
      <PendingFiles
        files={files}
        onRemove={(index) => setFiles((l) => l.filter((_, j) => j !== index))}
      />
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <ChoicePill
          label={t("field.team")}
          choices={ws.teams.map((x) => ({ id: x.id, label: x.name, icon: <TeamIcon team={x} /> }))}
          value={teamId}
          onChange={(k) => {
            if (!k) return;
            setTeamId(k);
            setStageId(null);
            setSprintId(null);
            setAssignee(null);
          }}
        />
        {team && <StagePill team={team} value={effectiveStageId} onChange={pickStage} />}
        <ChoicePill
          label={t("field.priority")}
          choices={PRIORITIES.filter((p) => p !== "none").map((p) => ({
            id: p,
            label: t(`priority.${p}`),
            icon: <PriorityIcon priority={p} />,
          }))}
          none={{ id: "none", label: t("priority.none"), icon: <PriorityIcon priority="none" /> }}
          emptyIcon={<PriorityIcon priority="none" />}
          value={priority === "none" ? null : priority}
          onChange={(k) => setPriority((k as Priority | null) ?? "none")}
        />
        <AssigneePill team={team} value={assignee} onChange={setAssignee} />
        <LabelsPill value={labels} onChange={setLabels} />
        <ExtraPills
          projects={projects}
          sprints={sprints}
          projectId={projectId}
          setProjectId={setProjectId}
          sprintId={sprintId}
          setSprintId={pickSprint}
          deadline={deadline}
          setDeadline={setDeadline}
          estimate={estimate}
          setEstimate={setEstimate}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-destructive">
          {error}
        </p>
      )}
      <div className="-mx-5 mt-5 flex items-center gap-2 border-t border-border px-5 pt-3">
        <FileTrigger allowsMultiple onSelect={addFiles}>
          <Tip label={t("attachments.add")}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("attachments.add")}
              isDisabled={offline}
            >
              <Paperclip aria-hidden />
            </Button>
          </Tip>
        </FileTrigger>
        <Button
          type="submit"
          variant="primary"
          className="ml-auto"
          isDisabled={!title.trim() || pending}
          aria-busy={pending || undefined}
        >
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          {pending ? t("issue.creating") : t("issue.create")}
        </Button>
      </div>
    </Form>
  );
}

function StagePill({
  team,
  value,
  onChange,
}: {
  team: Team;
  value: Id | null;
  onChange: (id: Id | null) => void;
}) {
  const { t } = useI18n();
  const stages = [...team.stages].sort((a, b) => a.position - b.position);
  return (
    <ChoicePill
      label={t("field.stage")}
      choices={stages.map((s) => ({ id: s.id, label: s.name, icon: <StageIcon kind={s.kind} /> }))}
      value={value}
      onChange={(k) => k && onChange(k)}
    />
  );
}

function AssigneePill({
  team,
  value,
  onChange,
}: {
  team: Team | undefined;
  value: Id | null;
  onChange: (id: Id | null) => void;
}) {
  const { t } = useI18n();
  const { members } = useWorkspace();
  const ids = new Set(team?.members ?? []);
  const pool = members.filter((m) => ids.size === 0 || ids.has(m.id) || m.id === value);
  return (
    <ChoicePill
      label={t("field.assignee")}
      choices={pool.map((m) => ({
        id: m.id,
        label: m.display_name,
        icon: <Avatar name={m.display_name} src={m.avatar_url} size={16} />,
      }))}
      none={{ id: "none", label: t("assignee.none"), icon: <User aria-hidden /> }}
      emptyIcon={<User aria-hidden className="size-3.5" />}
      value={value}
      onChange={onChange}
    />
  );
}

const LABELS_SHOWN = 2;

function LabelsPill({ value, onChange }: { value: Id[]; onChange: (ids: Id[]) => void }) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  const wanted = new Set(value);
  const chosen = ws.labels.filter((l) => wanted.has(l.id));
  return (
    <LabelsPicker
      value={value}
      onChange={onChange}
      trigger={
        <Pill
          isEmpty={chosen.length === 0}
          aria-label={
            chosen.length
              ? `${t("field.labels")}: ${chosen.map((l) => l.name).join(", ")}`
              : t("field.labels")
          }
        >
          {chosen.length === 0 ? (
            <>
              <Tag aria-hidden className="size-3.5" />
              {t("field.labels")}
            </>
          ) : (
            <>
              {chosen.slice(0, LABELS_SHOWN).map((l) => (
                <span key={l.id} className="inline-flex min-w-0 items-center gap-1.5">
                  <LabelDot color={l.color} />
                  <span className="truncate">{l.name}</span>
                </span>
              ))}
              {chosen.length > LABELS_SHOWN && (
                <span className="text-muted-foreground">+{chosen.length - LABELS_SHOWN}</span>
              )}
            </>
          )}
        </Pill>
      }
    />
  );
}

/**
 * Project, sprint, deadline and estimate. Each shows as a pill once it has a value; until then it
 * waits behind the "more" pill.
 */
function ExtraPills({
  projects,
  sprints,
  projectId,
  setProjectId,
  sprintId,
  setSprintId,
  deadline,
  setDeadline,
  estimate,
  setEstimate,
}: {
  projects: Pick<Project, "id" | "name">[];
  sprints: Pick<Sprint, "id" | "number" | "name">[];
  projectId: Id | null;
  setProjectId: (id: Id | null) => void;
  sprintId: Id | null;
  setSprintId: (id: Id | null) => void;
  deadline: string | null;
  setDeadline: (iso: string | null) => void;
  estimate: number | null;
  setEstimate: (n: number | null) => void;
}) {
  const { t } = useI18n();
  // The property whose picker is open. Its pill shows while open, even with no value.
  const [open, setOpen] = useState<Extra | null>(null);
  const values: Record<Extra, unknown> = {
    project: projectId,
    sprint: sprintId,
    deadline,
    estimate,
  };
  const available: Record<Extra, boolean> = {
    project: projects.length > 0,
    sprint: sprints.length > 0,
    deadline: true,
    estimate: true,
  };
  const shows = (key: Extra) => Boolean(values[key]) || open === key;
  const hidden = EXTRAS.filter((key) => !values[key] && available[key]);
  const openProps = (key: Extra) => ({
    isOpen: open === key,
    onOpenChange: (o: boolean) => setOpen(o ? key : null),
  });
  return (
    <>
      {shows("project") && (
        <ChoicePill
          {...openProps("project")}
          label={t("field.project")}
          choices={projects.map((p) => ({
            id: p.id,
            label: p.name,
            icon: <FolderKanban aria-hidden className="size-3.5 text-muted-foreground" />,
          }))}
          none={{ id: "none", label: t("project.none") }}
          emptyIcon={<FolderKanban aria-hidden className="size-3.5" />}
          value={projectId}
          onChange={setProjectId}
        />
      )}
      {shows("sprint") && (
        <ChoicePill
          {...openProps("sprint")}
          label={t("field.sprint")}
          choices={sprints.map((s) => ({
            id: s.id,
            label: sprintLabel(s),
            icon: <IterationCw aria-hidden className="size-3.5 text-muted-foreground" />,
          }))}
          none={{ id: "none", label: t("sprint.none") }}
          emptyIcon={<IterationCw aria-hidden className="size-3.5" />}
          value={sprintId}
          onChange={setSprintId}
        />
      )}
      {shows("deadline") && (
        <DatePill
          {...openProps("deadline")}
          label={t("field.deadline")}
          value={deadline}
          onChange={setDeadline}
        />
      )}
      {shows("estimate") && (
        <ChoicePill
          {...openProps("estimate")}
          label={t("field.estimate")}
          choices={ESTIMATES.map((v) => ({
            id: String(v),
            label: `${v} ${t("estimate.unit")}`,
            icon: <Gauge aria-hidden className="size-3.5 text-muted-foreground" />,
          }))}
          none={{ id: "none", label: t("estimate.none") }}
          emptyIcon={<Gauge aria-hidden className="size-3.5" />}
          value={estimate ? String(estimate) : null}
          onChange={(k) => setEstimate(k ? Number(k) : null)}
        />
      )}
      {hidden.length > 0 && open === null && (
        <MoreProperties
          hidden={hidden}
          // Opened a frame later so the menu has handed focus back before the picker takes it.
          onPick={(key) => requestAnimationFrame(() => setOpen(key))}
        />
      )}
    </>
  );
}

const EXTRAS: Extra[] = ["project", "sprint", "deadline", "estimate"];

const EXTRA_ICONS = {
  project: FolderKanban,
  sprint: IterationCw,
  deadline: CalendarDays,
  estimate: Gauge,
} as const;

function MoreProperties({ hidden, onPick }: { hidden: Extra[]; onPick: (key: Extra) => void }) {
  const { t } = useI18n();
  return (
    <MenuTrigger>
      <Tip label={t("issue.moreProperties")}>
        <Pill isEmpty aria-label={t("issue.moreProperties")} className="px-2">
          <Ellipsis aria-hidden className="size-3.5" />
        </Pill>
      </Tip>
      <MenuPopover placement="bottom start">
        <Menu aria-label={t("issue.moreProperties")} onAction={(k) => onPick(k as Extra)}>
          {hidden.map((key) => {
            const Icon = EXTRA_ICONS[key];
            return (
              <MenuItem key={key} id={key} textValue={t(`field.${key}`)}>
                <Icon aria-hidden />
                {t(`field.${key}`)}
              </MenuItem>
            );
          })}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

function defaultTeamId(teams: readonly Team[], me: Id, d: Partial<IssueInput>): Id | undefined {
  const myTeam = teams.find((tm) => tm.members.includes(me)) ?? teams[0];
  return d.team_id ?? myTeam?.id;
}

function resolveStageId(team: Team | undefined, stageId: Id | null, sprintId: Id | null) {
  return stageId && team?.stages.some((s) => s.id === stageId)
    ? stageId
    : defaultStageId(team?.stages ?? [], sprintId);
}

/**
 * The team's sprint stage for sprint work, else its first planned or backlog stage by position,
 * else its first stage.
 */
function defaultStageId(stages: readonly Stage[], sprintId: Id | null) {
  if (sprintId) return sprintStageId(stages) ?? stages[0]?.id ?? null;
  const open = [...stages]
    .sort((a, b) => a.position - b.position)
    .find((s) => s.kind === "planned" || s.kind === "backlog");
  return (open ?? stages[0])?.id ?? null;
}

function NeedTeam({ wsSlug, onNavigate }: { wsSlug: string; onNavigate: () => void }) {
  const { t } = useI18n();
  return (
    <div className="py-6 text-center">
      <p className=" text-muted-foreground">{t("issue.needTeam")}</p>
      <Link
        to={`/${wsSlug}/settings/teams`}
        onClick={onNavigate}
        className="mt-3 inline-block  font-medium text-primary hover:underline"
      >
        {t("team.create")}
      </Link>
    </div>
  );
}

/** Files picked for upload once the issue exists. */
function PendingFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useI18n();
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {files.map((f, i) => (
        <li
          key={i}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 "
        >
          <Paperclip aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate break-all">{f.name}</span>
          <span className="shrink-0 text-muted-foreground">{bytes(f.size)}</span>
          <button type="button" aria-label={t("action.remove")} onClick={() => onRemove(i)}>
            <X aria-hidden className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
