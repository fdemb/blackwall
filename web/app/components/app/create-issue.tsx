import { lazy, Suspense, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { useNavigate } from "react-router";
import { ChevronDown, Loader2, Paperclip, X } from "lucide-react";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input, Label } from "~/components/ui/field";
import { DatePicker } from "~/components/ui/date-picker";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { bytes, ellipsis, MAX_UPLOAD, sprintLabel } from "~/lib/format";
import { usePending } from "~/lib/use-pending";
import { cn } from "~/lib/utils";
import { useI18n } from "~/lib/i18n";
import { sprintStageId } from "~/lib/teams";
import { useWorkspace } from "~/lib/workspace";
import type { Id, IssueInput, Priority, Sprint, Stage } from "~/lib/types";
import { TeamIcon } from "./team-icon";
// Loaded on demand: the editor (and the markdown renderer it pulls in) is the heaviest part of
// this dialog, and most opens never touch the description.
const MarkdownEditor = lazy(() =>
  import("./markdown").then((m) => ({ default: m.MarkdownEditor })),
);
import {
  AssigneePicker,
  LabelsPicker,
  NullableSelect,
  PriorityPicker,
  StagePicker,
} from "./pickers";
import { Link } from "react-router";

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
  const { ws, me, create, run, upload, offline, issuePath } = useWorkspace();
  const myTeam = ws.teams.find((tm) => tm.members.includes(me)) ?? ws.teams[0];
  const d = create.defaults;
  const [teamId, setTeamId] = useState<Id | undefined>(d.team_id ?? myTeam?.id);
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
  const [estimate, setEstimate] = useState("");
  const [deadline, setDeadline] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const { pending, error, guard } = usePending();
  const [more, setMore] = useState(Boolean(d.project_id || d.sprint_id || d.labels?.length));
  useDialogDirty(title.trim() !== "" || description !== "" || files.length > 0);

  // The picker always shows a stage from the current team. A stale choice, from the defaults or a
  // previous team, falls back to the team's default stage.
  const effectiveStageId =
    stageId && team?.stages.some((s) => s.id === stageId)
      ? stageId
      : defaultStageId(team?.stages ?? [], sprintId);
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
        estimate: estimate ? Number(estimate) : null,
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
      if (id) void nav(issuePath(id));
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
      className="flex flex-col gap-3"
    >
      <Input
        autoFocus
        aria-label={t("field.title")}
        placeholder={t("issue.titlePlaceholder")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        className="h-10 rounded border-transparent bg-transparent px-0 text-base font-semibold shadow-none focus:border-transparent focus:ring-2 focus:ring-ring/60"
      />
      <Suspense
        fallback={
          <div
            aria-busy
            className="grid h-24 animate-pulse place-items-center rounded-lg border border-input bg-muted/40  text-muted-foreground"
          >
            {ellipsis(t("action.loading"))}
          </div>
        }
      >
        <MarkdownEditor
          label={t("field.description")}
          value={description}
          onChange={setDescription}
          placeholder={t("issue.descriptionPlaceholder")}
          onSubmit={submit}
        />
      </Suspense>
      <PendingFiles
        files={files}
        onRemove={(index) => setFiles((l) => l.filter((_, j) => j !== index))}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Select
          label={t("field.team")}
          options={ws.teams.map((x) => ({ id: x.id, label: x.name, icon: <TeamIcon team={x} /> }))}
          selectedKey={teamId}
          onSelectionChange={(k) => {
            setTeamId(k as Id);
            setStageId(null);
            setSprintId(null);
            setAssignee(null);
          }}
        />
        {teamId && (
          <StagePicker
            label={t("field.stage")}
            teamId={teamId}
            value={effectiveStageId}
            onChange={pickStage}
          />
        )}
        <PriorityPicker label={t("field.priority")} value={priority} onChange={setPriority} />
        <AssigneePicker
          label={t("field.assignee")}
          teamId={teamId}
          value={assignee}
          onChange={setAssignee}
        />
      </div>
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          aria-expanded={more}
          onPress={() => setMore(!more)}
        >
          <ChevronDown aria-hidden className={cn("transition-transform", !more && "-rotate-90")} />
          {more ? t("issue.fewerProperties") : t("issue.moreProperties")}
        </Button>
        {more && (
          <ExtendedProperties
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
            labels={labels}
            setLabels={setLabels}
          />
        )}
      </div>
      {error && (
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <FileTrigger allowsMultiple onSelect={addFiles}>
          <Button variant="ghost" isDisabled={offline}>
            <Paperclip aria-hidden />
            {t("attachments.add")}
          </Button>
        </FileTrigger>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onPress={create.hide}>
            {t("action.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={!title.trim() || pending}
            aria-busy={pending || undefined}
          >
            {pending && <Loader2 aria-hidden className="animate-spin" />}
            {pending ? t("issue.creating") : t("issue.create")}
          </Button>
        </div>
      </div>
    </Form>
  );
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

/**
 * The extended property grid behind the "more" toggle. Composed by `CreateIssueForm` instead of a
 * boolean branch so the basic and extended variants stay separate pieces.
 */
function ExtendedProperties({
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
  labels,
  setLabels,
}: {
  projects: { id: Id; name: string }[];
  sprints: Pick<Sprint, "id" | "number" | "name">[];
  projectId: Id | null;
  setProjectId: (id: Id | null) => void;
  sprintId: Id | null;
  setSprintId: (id: Id | null) => void;
  deadline: string | null;
  setDeadline: (v: string | null) => void;
  estimate: string;
  setEstimate: (v: string) => void;
  labels: Id[];
  setLabels: (ids: Id[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <NullableSelect
        label={t("field.project")}
        noneLabel={t("project.none")}
        value={projectId}
        onChange={setProjectId}
        options={projects.map((p) => ({ id: p.id, label: p.name }))}
      />
      <NullableSelect
        label={t("field.sprint")}
        noneLabel={t("sprint.none")}
        value={sprintId}
        onChange={setSprintId}
        options={sprints.map((s) => ({ id: s.id, label: sprintLabel(s) }))}
      />
      <DatePicker label={t("field.deadline")} value={deadline} onChange={setDeadline} />
      <div>
        <Label>{t("field.estimate")}</Label>
        <Input
          aria-label={t("field.estimate")}
          type="number"
          min={0}
          max={1000}
          inputMode="numeric"
          placeholder="0"
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
        />
      </div>
      <div className="col-span-2 sm:col-span-1">
        <Label>{t("field.labels")}</Label>
        <LabelsPicker variant="field" value={labels} onChange={setLabels} />
      </div>
    </div>
  );
}
