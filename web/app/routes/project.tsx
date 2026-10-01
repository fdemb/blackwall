import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, Navigate, useParams } from "react-router";
import { CalendarDays, ChevronLeft, Flag, Pencil, Plus } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { IssueList } from "~/components/app/issue-list";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { ProgressBar } from "~/components/app/progress";
import { applyFilter, isDone } from "~/lib/filters";
import { daysUntil, fullDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { ProjectForm } from "./projects";

export default function ProjectPage() {
  const { t, lang } = useI18n();
  const { projectId, ws: wsId } = useParams();
  const { ws, run, canWrite, create } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const project = ws.projects.find((p) => p.id === projectId);
  if (!project) return <Navigate to={`/${wsId}/projects`} replace />;
  const issues = applyFilter(ws, { project_id: project.id });
  const done = issues.filter((i) => isDone(ws, i)).length;
  const milestones = ws.milestones.filter((m) => m.project_id === project.id).sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));
  const teams = (project.team_ids.length ? project.team_ids : [...new Set(issues.map((i) => i.team_id))]).map((id) => ws.teams.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <Page>
      <PageHeader
        title={project.name}
        icon={<Link to={`/${ws.id}/projects`} aria-label={t("action.back")} className="-ml-1 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="size-4" /></Link>}
        actions={<>
          {canWrite && <Button variant="ghost" size="sm" onPress={() => setEditing(true)}><Pencil />{t("action.edit")}</Button>}
          {canWrite && <Button variant="primary" size="sm" onPress={() => create.show({ project_id: project.id })}><Plus />{t("issue.new")}</Button>}
        </>}
      />
      <Scroll>
        <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-6 lg:order-1">
            {project.description && <p className="max-w-2xl text-[14px] leading-6 text-muted-foreground">{project.description}</p>}
            <div className="overflow-hidden rounded-xl border border-border">
              <IssueList issues={issues} groupBy="stage" showTeam emptyState={<EmptyState title={t("empty.issues")} description={t("project.issuesEmpty")} />} />
            </div>
          </div>
          <aside className="space-y-6 lg:order-2">
            <section>
              <h2 className="mb-2 text-[13px] font-semibold">{t("project.progress")}</h2>
              <ProgressBar value={done} total={issues.length} label={t("project.progress")} />
              <p className="mt-1.5 text-xs tabular-nums text-muted-foreground">{t("project.doneOf", { done, total: issues.length })}</p>
              <ul className="mt-3 space-y-2">
                {teams.map((tm) => {
                  const list = issues.filter((i) => i.team_id === tm.id);
                  const d = list.filter((i) => isDone(ws, i)).length;
                  return (
                    <li key={tm.id} className="text-xs">
                      <div className="mb-1 flex justify-between"><span className="font-medium">{tm.name}</span><span className="tabular-nums text-muted-foreground">{d}/{list.length}</span></div>
                      <ProgressBar value={d} total={list.length} label={tm.name} className="h-1" />
                    </li>
                  );
                })}
              </ul>
            </section>
            <section>
              <div className="mb-2 flex items-center">
                <h2 className="text-[13px] font-semibold">{t("project.milestones")}</h2>
                {canWrite && <Button variant="ghost" size="sm" className="ml-auto" onPress={() => setAddingMilestone(true)}><Plus />{t("milestone.new")}</Button>}
              </div>
              {milestones.length === 0 ? <p className="text-[13px] text-muted-foreground">{t("milestone.empty")}</p> : (
                <ul className="space-y-2">
                  {milestones.map((m) => {
                    const list = issues.filter((i) => i.milestone_id === m.id);
                    const d = list.filter((i) => isDone(ws, i)).length;
                    const late = m.deadline && daysUntil(m.deadline) < 0 && d < list.length;
                    return (
                      <li key={m.id} className="rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center gap-2 text-[13px] font-medium"><Flag className="size-3.5 text-primary" />{m.name}{late && <Badge tone="danger">{t("deadline.overdue")}</Badge>}</div>
                        {m.deadline && <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><CalendarDays className="size-3" />{fullDate(m.deadline, lang)}</p>}
                        <ProgressBar value={d} total={list.length} label={m.name} className="mt-2 h-1" />
                        <p className="mt-1 text-xs tabular-nums text-muted-foreground">{d}/{list.length}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </Scroll>
      <Dialog title={t("project.edit")} isOpen={editing} onOpenChange={setEditing}>{(close) => <ProjectForm project={project} close={close} />}</Dialog>
      <Dialog title={t("milestone.new")} size="sm" isOpen={addingMilestone} onOpenChange={setAddingMilestone}>
        {(close) => <MilestoneForm projectId={project.id} close={close} />}
      </Dialog>
    </Page>
  );
}

function MilestoneForm({ projectId, close }: { projectId: string; close: () => void }) {
  const t = useI18n().t;
  const { run } = useWorkspace();
  const [name, setName] = useState("");
  const [deadline, setDeadline] = useState<string | null>(null);
  return (
    <Form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); await run({ type: "create_milestone", project_id: projectId, name: name.trim(), deadline }).then(close).catch(() => {}); }}>
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      <DatePicker label={t("field.deadline")} value={deadline} onChange={setDeadline} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>{t("action.cancel")}</Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim()}>{t("action.save")}</Button>
      </div>
    </Form>
  );
}
