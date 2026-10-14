import { useState } from "react";
import { Form } from "react-aria-components";
import { Navigate, useParams } from "react-router";
import { CalendarDays, Flag, Pencil, Plus } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { FilterBar } from "~/components/app/filter-bar";
import { IssueList } from "~/components/app/issue-list";
import { useQueueState } from "~/components/app/workbench";
import { EmptyState, Page, PageHeader, PageHeading, Scroll } from "~/components/app/page";
import { ProgressBar } from "~/components/app/progress";
import { daysUntil, fullDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useProjectStats } from "~/lib/stats";
import { useWorkspace } from "~/lib/workspace";
import { ProjectForm } from "./projects";
import { effectiveFilter, isNarrowed, whereIs } from "~/lib/filters";
import type { IssueFilter, Milestone } from "~/lib/types";

export default function ProjectPage() {
  const { t, lang } = useI18n();
  const { projectId, ws: wsId } = useParams();
  const { ws, canWrite, create } = useWorkspace();
  const projectStats = useProjectStats();
  const [editing, setEditing] = useState(false);
  const [milestoneForm, setMilestoneForm] = useState<Milestone | "new" | null>(null);
  const { filter, setFilter } = useQueueState();
  const base: IssueFilter = { where: [whereIs("project_id", projectId ?? "")] };
  const query = useIssues(effectiveFilter(filter, base), Boolean(projectId));
  const project = ws.projects.find((p) => p.id === projectId);
  if (!project) return <Navigate to={`/${wsId}/projects`} replace />;
  const stats = projectStats.get(project.id);
  const total = stats?.total ?? 0;
  const shown = query.items;
  const narrowed = isNarrowed(filter);
  const done = stats?.completed ?? 0;
  const milestones = ws.milestones
    .filter((m) => m.project_id === project.id)
    .sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));
  const teams = (
    project.team_ids.length ? project.team_ids : (stats?.teams ?? []).map((team) => team.id)
  )
    .map((id) => ws.teams.find((x) => x.id === id))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <Page>
      <PageHeader
        title={project.name}
        heading={
          <PageHeading parent={{ to: `/${ws.slug}/projects`, label: t("nav.projects") }}>
            {project.name}
          </PageHeading>
        }
        actions={
          <>
            {canWrite && (
              <Button variant="ghost" size="sm" onPress={() => setEditing(true)}>
                <Pencil />
                {t("action.edit")}
              </Button>
            )}
            {canWrite && (
              <Button
                variant="primary"
                size="sm"
                onPress={() => create.show({ project_id: project.id })}
              >
                <Plus />
                {t("issue.new")}
              </Button>
            )}
          </>
        }
      />
      <Scroll>
        <div className="grid gap-6 p-4 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-6 lg:order-1">
            {project.description && (
              <p className="max-w-2xl text-[14px] leading-6 text-muted-foreground">
                {project.description}
              </p>
            )}
            {total > 0 && (
              <div className="-mx-4">
                <FilterBar
                  filter={filter}
                  onChange={setFilter}
                  hide={["project_id", "team_id", "sprint_id"]}
                  scope={base}
                  saveable={false}
                />
              </div>
            )}
            <QueryStatus query={query} />
            <div className="overflow-hidden rounded-xl border border-border">
              <IssueList
                issues={shown}
                groupBy="stage"
                showTeam
                emptyState={
                  narrowed ? (
                    <EmptyState
                      title={t("empty.noMatch")}
                      description={t("empty.noMatchSub")}
                      action={<Button onPress={() => setFilter({})}>{t("filter.clear")}</Button>}
                    />
                  ) : (
                    <EmptyState title={t("empty.issues")} description={t("project.issuesEmpty")} />
                  )
                }
              />
            </div>
          </div>
          <aside className="space-y-6 lg:order-2">
            <section>
              <h2 className="mb-2  font-semibold">{t("project.progress")}</h2>
              <ProgressBar value={done} total={total} label={t("project.progress")} />
              <p className="mt-1.5  tabular-nums text-muted-foreground">
                {t("project.doneOf", { done, total: total })}
              </p>
              <ul className="mt-3 space-y-2">
                {teams.map((tm) => {
                  const teamStats = stats?.teams.find((stats) => stats.id === tm.id);
                  const count = teamStats?.total ?? 0;
                  const d = teamStats?.completed ?? 0;
                  return (
                    <li key={tm.id} className="">
                      <div className="mb-1 flex justify-between">
                        <span className="font-medium">{tm.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {d}/{count}
                        </span>
                      </div>
                      <ProgressBar value={d} total={count} label={tm.name} className="h-1" />
                    </li>
                  );
                })}
              </ul>
            </section>
            <section>
              <div className="mb-2 flex items-center">
                <h2 className=" font-semibold">{t("project.milestones")}</h2>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onPress={() => setMilestoneForm("new")}
                  >
                    <Plus />
                    {t("milestone.new")}
                  </Button>
                )}
              </div>
              {milestones.length === 0 ? (
                <p className=" text-muted-foreground">{t("milestone.empty")}</p>
              ) : (
                <ul className="space-y-2">
                  {milestones.map((m) => {
                    const milestoneStats = stats?.milestones.find((stats) => stats.id === m.id);
                    const count = milestoneStats?.total ?? 0;
                    const d = milestoneStats?.completed ?? 0;
                    const late = m.deadline && daysUntil(m.deadline) < 0 && d < count;
                    return (
                      <li key={m.id} className="rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center gap-2  font-medium">
                          <Flag className="size-3.5 shrink-0 text-primary" />
                          <span className="min-w-0 flex-1 truncate">{m.name}</span>
                          {late && <Badge tone="danger">{t("deadline.overdue")}</Badge>}
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="-my-1 -mr-1"
                              aria-label={`${t("milestone.edit")}: ${m.name}`}
                              onPress={() => setMilestoneForm(m)}
                            >
                              <Pencil />
                            </Button>
                          )}
                        </div>
                        {m.deadline && (
                          <p className="mt-0.5 flex items-center gap-1  text-muted-foreground">
                            <CalendarDays className="size-3" />
                            {fullDate(m.deadline, lang)}
                          </p>
                        )}
                        <ProgressBar value={d} total={count} label={m.name} className="mt-2 h-1" />
                        <p className="mt-1  tabular-nums text-muted-foreground">
                          {d}/{count}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </Scroll>
      <Dialog title={t("project.edit")} isOpen={editing} onOpenChange={setEditing}>
        {(close) => <ProjectForm project={project} close={close} />}
      </Dialog>
      <Dialog
        title={milestoneForm === "new" ? t("milestone.new") : t("milestone.edit")}
        size="sm"
        isOpen={milestoneForm !== null}
        onOpenChange={(o) => !o && setMilestoneForm(null)}
      >
        {(close) => (
          <MilestoneForm
            projectId={project.id}
            milestone={milestoneForm === "new" ? null : milestoneForm}
            close={close}
          />
        )}
      </Dialog>
    </Page>
  );
}

function MilestoneForm({
  projectId,
  milestone,
  close,
}: {
  projectId: string;
  milestone: Milestone | null;
  close: () => void;
}) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const { pending, error, guard } = usePending();
  const [name, setName] = useState(milestone?.name ?? "");
  const [deadline, setDeadline] = useState<string | null>(milestone?.deadline ?? null);
  useDialogDirty(name !== (milestone?.name ?? "") || deadline !== (milestone?.deadline ?? null));
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          const body = { name: name.trim(), deadline };
          await run(
            milestone
              ? { type: "update_milestone", id: milestone.id, ...body }
              : { type: "create_milestone", project_id: projectId, ...body },
            {
              quiet: true,
              expectedVersions: error
                ? undefined
                : milestone
                  ? { [milestone.id]: milestone.version }
                  : {},
            },
          );
          close();
        });
      }}
    >
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      <DatePicker label={t("field.deadline")} value={deadline} onChange={setDeadline} />
      {error && (
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
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
