import { useEffect, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { useNavigate } from "react-router";
import { Paperclip, X } from "lucide-react";
import { Dialog } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input, Label } from "~/components/ui/field";
import { DatePicker } from "~/components/ui/date-picker";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { bytes } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, IssueInput, Priority } from "~/lib/types";
import { MarkdownEditor } from "./markdown";
import { AssigneePicker, LabelsPicker, NullableSelect, PriorityPicker, StagePicker } from "./pickers";
import { Link } from "react-router";

export function CreateIssueDialog() {
  const { create } = useWorkspace();
  const t = useT();
  return (
    <Dialog title={t("issue.new")} size="lg" position="top" isOpen={create.open} onOpenChange={(o) => !o && create.hide()}>
      {() => <CreateIssueForm />}
    </Dialog>
  );
}

function CreateIssueForm() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { ws, me, create, run, upload } = useWorkspace();
  const myTeam = ws.teams.find((tm) => tm.members.includes(me)) ?? ws.teams[0];
  const d = create.defaults;
  const [teamId, setTeamId] = useState<Id | undefined>(d.team_id ?? myTeam?.id);
  const team = ws.teams.find((x) => x.id === teamId);
  const firstStage = [...(team?.stages ?? [])].sort((a, b) => a.position - b.position).find((s) => s.kind === "planned" || s.kind === "backlog") ?? team?.stages[0];
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!team) return;
    if (!stageId || !team.stages.some((s) => s.id === stageId)) setStageId(firstStage?.id ?? null);
  }, [team?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ws.teams.length === 0)
    return (
      <div className="py-6 text-center">
        <p className="text-[13px] text-muted-foreground">{t("issue.needTeam")}</p>
        <Link to={`/${ws.id}/settings/teams`} onClick={create.hide} className="mt-3 inline-block text-[13px] font-medium text-primary hover:underline">
          {t("team.create")}
        </Link>
      </div>
    );

  const sprints = ws.sprints.filter((s) => s.team_id === teamId && (s.state === "planned" || s.state === "active"));
  const projects = ws.projects.filter((p) => !teamId || p.team_ids.length === 0 || p.team_ids.includes(teamId));

  const submit = async () => {
    if (!title.trim() || !teamId) return;
    setBusy(true);
    const input: IssueInput = {
      title: title.trim(), description, team_id: teamId, stage_id: stageId, assignee, priority, labels,
      estimate: estimate ? Number(estimate) : null, deadline, project_id: projectId, sprint_id: sprintId, parent_id: parentId,
    };
    try {
      const id = await run({ type: "create_issue", input });
      for (const file of files) if (id) await upload(id, file).catch(() => {});
      toast.show(t("issue.created"));
      create.hide();
      if (id) nav(`/${ws.id}/issue/${id}`);
    } catch {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3">
      <Input autoFocus aria-label={t("field.title")} placeholder={t("issue.titlePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="h-10 border-transparent bg-transparent px-0 text-base font-semibold shadow-none focus:ring-0 focus:border-transparent" />
      <MarkdownEditor label={t("field.description")} value={description} onChange={setDescription} placeholder={t("issue.descriptionPlaceholder")} onSubmit={submit} />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs">
              <Paperclip className="size-3" />{f.name}<span className="text-muted-foreground">{bytes(f.size)}</span>
              <button type="button" aria-label={t("action.remove")} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Select label={t("field.team")} options={ws.teams.map((x) => ({ id: x.id, label: x.name }))} selectedKey={teamId} onSelectionChange={(k) => { setTeamId(k as Id); setStageId(null); setSprintId(null); setAssignee(null); }} />
        {teamId && <StagePicker label={t("field.stage")} teamId={teamId} value={stageId} onChange={setStageId} />}
        <PriorityPicker label={t("field.priority")} value={priority} onChange={setPriority} />
        <AssigneePicker label={t("field.assignee")} teamId={teamId} value={assignee} onChange={setAssignee} />
        <NullableSelect label={t("field.project")} noneLabel={t("project.none")} value={projectId} onChange={setProjectId} options={projects.map((p) => ({ id: p.id, label: p.name }))} />
        <NullableSelect label={t("field.sprint")} noneLabel={t("sprint.none")} value={sprintId} onChange={setSprintId} options={sprints.map((s) => ({ id: s.id, label: s.name }))} />
        <DatePicker label={t("field.deadline")} value={deadline} onChange={setDeadline} />
        <div>
          <Label>{t("field.estimate")}</Label>
          <Input aria-label={t("field.estimate")} type="number" min={0} max={1000} inputMode="numeric" placeholder="0" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <Label>{t("field.labels")}</Label>
          <LabelsPicker variant="field" value={labels} onChange={setLabels} />
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <FileTrigger allowsMultiple onSelect={(list) => list && setFiles((l) => [...l, ...Array.from(list)])}>
          <Button variant="ghost"><Paperclip />{t("attachments.add")}</Button>
        </FileTrigger>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onPress={create.hide}>{t("action.cancel")}</Button>
          <Button type="submit" variant="primary" isDisabled={!title.trim() || busy}>{t("issue.create")}</Button>
        </div>
      </div>
    </Form>
  );
}
