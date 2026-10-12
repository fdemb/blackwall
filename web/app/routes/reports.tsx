import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { BarChart3, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Tab, TabList, TabPanel, Tabs } from "~/components/ui/tabs";
import { BarList, Columns } from "~/components/app/charts";
import { ConfirmDialog } from "~/components/app/confirm";
import { Card, EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { ProgressBar } from "~/components/app/progress";
import { TimeForm } from "~/components/app/time-form";
import { formatMinutes, fullDate, issueKey } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useIssues, useTimeEntries } from "~/lib/queries";
import { reportQuery } from "~/lib/query-client";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import type { Report, TimeEntry } from "~/lib/types";

export default function Reports() {
  const { t, lang } = useI18n();
  const { ws } = useWorkspace();
  // Time entries only load when the tab is open, so the overview never pays for them.
  const [tab, setTab] = useState("overview");
  const query = useQuery(reportQuery(ws.id));
  const report = query.data;
  const error = query.isError && !report ? query.error.message || t("reports.loadFailed") : "";

  return (
    <Page>
      <Tabs
        selectedKey={tab}
        onSelectionChange={(k) => setTab(String(k))}
        className="min-h-0 flex-1 gap-0"
      >
        <PageHeader
          title={t("nav.reports")}
          icon={<BarChart3 className="size-4 text-muted-foreground" />}
          nav={
            <TabList aria-label={t("nav.reports")}>
              <Tab id="overview" size="compact">
                {t("reports.overview")}
              </Tab>
              <Tab id="time" size="compact">
                {t("reports.time")}
              </Tab>
            </TabList>
          }
        />
        <Scroll>
          <TabPanel id="overview" className="space-y-4 p-4">
            {error ? (
              <div role="alert" className="flex flex-wrap items-center gap-3">
                <p className="text-destructive">{error}</p>
                <Button size="sm" onPress={() => void query.refetch()}>
                  {t("action.retry")}
                </Button>
              </div>
            ) : !report ? (
              <div className="h-40 animate-pulse rounded-xl bg-muted" />
            ) : (
              <Overview report={report} />
            )}
          </TabPanel>
          <TabPanel id="time" className="p-4">
            {tab === "time" && <TimeLog lang={lang} />}
          </TabPanel>
        </Scroll>
      </Tabs>
    </Page>
  );
}

function Overview({ report }: { report: Report }) {
  const { t } = useI18n();
  // Single pass for the header numbers instead of three separate reductions.
  const stats = useMemo(() => {
    let completed = 0;
    let open = 0;
    for (const d of report.delivery) completed += d.completed;
    for (const tm of report.teams) open += tm.open_issues;
    return { completed, open };
  }, [report]);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("reports.totalTime")} value={formatMinutes(report.total_minutes)} />
        <Stat
          label={t("reports.delivered")}
          value={String(stats.completed)}
          hint={t("reports.allTime")}
        />
        <Stat label={t("reports.openIssues")} value={String(stats.open)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ReportCard title={t("reports.delivery")}>
          {report.delivery.length === 0 ? (
            <p className=" text-muted-foreground">{t("reports.noDelivery")}</p>
          ) : (
            <Columns
              title={t("reports.delivery")}
              data={report.delivery.map((d) => ({ date: d.date, value: d.completed }))}
              label={(d, v) => `${d}: ${t("reports.completed", { n: v })}`}
            />
          )}
        </ReportCard>
        <ReportCard title={t("reports.workload")}>
          <Workload people={report.people} />
        </ReportCard>
        <ReportCard title={t("reports.sprints")}>
          <SprintOutcomes sprints={report.sprints} />
        </ReportCard>
        <ReportCard title={t("reports.timeBy")}>
          <TimeBy report={report} />
        </ReportCard>
      </div>
    </>
  );
}

function ReportCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3  font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function Workload({ people }: { people: Report["people"] }) {
  const { t } = useI18n();
  const { member } = useWorkspace();
  if (people.length === 0) return <p className=" text-muted-foreground">{t("reports.none")}</p>;
  return (
    <ul className="space-y-3">
      {people.map((p) => {
        const name = member(p.id)?.display_name ?? "?";
        return (
          <li key={p.id} className="flex items-center gap-3 ">
            <Avatar name={name} src={member(p.id)?.avatar_url} size={22} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="tabular-nums text-muted-foreground">
              {t("reports.openCount", { n: p.open_issues })}
            </span>
            <span className="w-16 text-right tabular-nums text-muted-foreground">
              {p.effort} {t("estimate.unit")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SprintOutcomes({ sprints }: { sprints: Report["sprints"] }) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  if (sprints.length === 0) return <p className=" text-muted-foreground">{t("reports.none")}</p>;
  return (
    <ul className="space-y-3">
      {sprints.map((s) => {
        const name = ws.sprints.find((x) => x.id === s.id)?.name;
        return (
          <li key={s.id} className="">
            <div className="mb-1 flex justify-between">
              <span className="font-medium">{name ?? "?"}</span>
              <span className="tabular-nums text-muted-foreground">
                {s.completed}/{s.total} · {s.effort} {t("estimate.unit")}
              </span>
            </div>
            <ProgressBar value={s.completed} total={s.total} label={name} />
          </li>
        );
      })}
    </ul>
  );
}

const TIME_GROUPS = ["teams", "projects", "people", "issues"] as const;

/** Top eight entries with logged time, per grouping. */
function TimeBy({ report }: { report: Report }) {
  const { t } = useI18n();
  const { ws, member } = useWorkspace();
  const nameOf = useMemo(
    () => ({
      people: (id: string) => member(id)?.display_name ?? "?",
      teams: (id: string) => ws.teams.find((x) => x.id === id)?.name ?? "?",
      projects: (id: string) => ws.projects.find((x) => x.id === id)?.name ?? "?",
      issues: (id: string) => {
        const i = report.issues.find((x) => x.id === id);
        return i ? `${issueKey(i.number)} ${i.title}` : "?";
      },
    }),
    [ws, member, report],
  );
  return (
    <Tabs>
      <TabList aria-label={t("reports.timeBy")}>
        <Tab id="teams">{t("nav.teams")}</Tab>
        <Tab id="projects">{t("nav.projects")}</Tab>
        <Tab id="people">{t("nav.people")}</Tab>
        <Tab id="issues">{t("nav.issues")}</Tab>
      </TabList>
      {TIME_GROUPS.map((k) => {
        const rows = report[k].filter((r) => r.minutes > 0);
        return (
          <TabPanel key={k} id={k}>
            {rows.length === 0 ? (
              <p className=" text-muted-foreground">{t("reports.noTime")}</p>
            ) : (
              <BarList
                rows={rows
                  .sort((a, b) => b.minutes - a.minutes)
                  .slice(0, 8)
                  .map((r) => ({ id: r.id, label: nameOf[k](r.id), value: r.minutes }))}
                format={formatMinutes}
              />
            )}
          </TabPanel>
        );
      })}
    </Tabs>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="flex items-baseline justify-between gap-2 text-muted-foreground">
        {label}
        {hint && <span className="text-[12px] text-muted-foreground/80">{hint}</span>}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
    </Card>
  );
}

function TimeLog({ lang }: { lang: string }) {
  const { t } = useI18n();
  const { ws, me, member, run, canAdmin } = useWorkspace();
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [deleting, setDeleting] = useState<TimeEntry | null>(null);
  const query = useTimeEntries();
  const ids = [...new Set(query.items.map((entry) => entry.issue_id))];
  const related = useIssues({ ids: ids.join(",") }, ids.length > 0);
  const issues = new Map(related.items.map((issue) => [issue.id, issue]));
  const entries = query.items;
  if (!entries.length && (query.loading || query.error)) return <QueryStatus query={query} />;
  if (!entries.length)
    return (
      <EmptyState
        icon={<BarChart3 />}
        title={t("time.emptyTitle")}
        description={t("time.emptySub")}
      />
    );
  return (
    <Card>
      <QueryStatus query={query} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] ">
          <thead>
            <tr className="border-b border-border text-left  text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t("field.date")}</th>
              <th className="px-2 py-2 font-medium">{t("nav.people")}</th>
              <th className="px-2 py-2 font-medium">{t("field.issue")}</th>
              <th className="px-2 py-2 text-right font-medium">{t("time.duration")}</th>
              <th className="px-2 py-2 font-medium">{t("time.note")}</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const issue = issues.get(e.issue_id);
              const m = member(e.user_id);
              return (
                <tr
                  key={e.id}
                  className="border-b border-border/60 last:border-0 hover:bg-muted/40"
                >
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                    {fullDate(e.logged_at, lang)}
                  </td>
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-2">
                      <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={18} />
                      {m?.display_name}
                    </span>
                  </td>
                  <td className="max-w-56 truncate px-2 py-2">
                    {issue ? (
                      <Link to={`/${ws.id}/issue/${issue.id}`} className="hover:underline">
                        <span className="tabular-nums text-muted-foreground">
                          {issueKey(issue.number)}
                        </span>{" "}
                        {issue.title}
                      </Link>
                    ) : (
                      "?"
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">
                    {formatMinutes(e.minutes)}
                  </td>
                  <td className="max-w-48 truncate px-2 py-2 text-muted-foreground">{e.note}</td>
                  <td className="px-2 py-2 text-right">
                    {(e.user_id === me || canAdmin) && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("action.edit")}
                          onPress={() => setEditing(e)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("action.delete")}
                          onPress={() => setDeleting(e)}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        title={t("time.deleteTitle")}
        description={t("time.deleteConfirmSub")}
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        onConfirm={() => run({ type: "delete_time", id: deleting!.id }, { quiet: true })}
      />
      <Dialog
        title={t("time.edit")}
        size="sm"
        isOpen={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        {(close) =>
          editing && <TimeForm issueId={editing.issue_id} entry={editing} close={close} />
        }
      </Dialog>
    </Card>
  );
}
