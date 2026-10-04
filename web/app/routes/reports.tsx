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
import type { TimeEntry } from "~/lib/types";

export default function Reports() {
  const { t, lang } = useI18n();
  const { ws, member } = useWorkspace();
  const query = useQuery(reportQuery(ws.id));
  const report = query.data;
  const error = query.isError && !report ? query.error.message || t("reports.loadFailed") : "";

  const nameOf = useMemo(
    () => ({
      people: (id: string) => member(id)?.display_name ?? "?",
      teams: (id: string) => ws.teams.find((x) => x.id === id)?.name ?? "?",
      projects: (id: string) => ws.projects.find((x) => x.id === id)?.name ?? "?",
      issues: (id: string) => {
        const i = report?.issues.find((x) => x.id === id);
        return i ? `${issueKey(i.number)} ${i.title}` : "?";
      },
    }),
    [ws, member, report],
  );

  const completed = report?.delivery.reduce((a, d) => a + d.completed, 0) ?? 0;

  return (
    <Page>
      <PageHeader
        title={t("nav.reports")}
        icon={<BarChart3 className="size-4 text-muted-foreground" />}
      />
      <Scroll>
        <Tabs className="p-4">
          <TabList aria-label={t("nav.reports")}>
            <Tab id="overview">{t("reports.overview")}</Tab>
            <Tab id="time">{t("reports.time")}</Tab>
          </TabList>
          <TabPanel id="overview" className="space-y-4">
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
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Stat
                    label={t("reports.totalTime")}
                    value={formatMinutes(report.total_minutes)}
                  />
                  <Stat
                    label={t("reports.delivered")}
                    value={String(completed)}
                    hint={t("reports.last30")}
                  />
                  <Stat
                    label={t("reports.openIssues")}
                    value={String(report.teams.reduce((a, x) => a + x.open_issues, 0))}
                  />
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card className="p-4">
                    <h2 className="mb-3 text-[13px] font-semibold">{t("reports.delivery")}</h2>
                    {report.delivery.length === 0 ? (
                      <p className="text-[13px] text-muted-foreground">{t("reports.noDelivery")}</p>
                    ) : (
                      <Columns
                        title={t("reports.delivery")}
                        data={report.delivery.map((d) => ({ date: d.date, value: d.completed }))}
                        label={(d, v) => `${d}: ${t("reports.completed", { n: v })}`}
                      />
                    )}
                  </Card>
                  <Card className="p-4">
                    <h2 className="mb-3 text-[13px] font-semibold">{t("reports.workload")}</h2>
                    {report.people.length === 0 ? (
                      <p className="text-[13px] text-muted-foreground">{t("reports.none")}</p>
                    ) : (
                      <ul className="space-y-3">
                        {report.people.map((p) => {
                          const m = member(p.id);
                          return (
                            <li key={p.id} className="flex items-center gap-3 text-[13px]">
                              <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={22} />
                              <span className="min-w-0 flex-1 truncate">
                                {m?.display_name ?? "?"}
                              </span>
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
                    )}
                  </Card>
                  <Card className="p-4">
                    <h2 className="mb-3 text-[13px] font-semibold">{t("reports.sprints")}</h2>
                    {report.sprints.length === 0 ? (
                      <p className="text-[13px] text-muted-foreground">{t("reports.none")}</p>
                    ) : (
                      <ul className="space-y-3">
                        {report.sprints.map((s) => {
                          const sp = ws.sprints.find((x) => x.id === s.id);
                          return (
                            <li key={s.id} className="text-[13px]">
                              <div className="mb-1 flex justify-between">
                                <span className="font-medium">{sp?.name ?? "?"}</span>
                                <span className="tabular-nums text-muted-foreground">
                                  {s.completed}/{s.total} · {s.effort} {t("estimate.unit")}
                                </span>
                              </div>
                              <ProgressBar value={s.completed} total={s.total} label={sp?.name} />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                  <Card className="p-4">
                    <h2 className="mb-3 text-[13px] font-semibold">{t("reports.timeBy")}</h2>
                    <Tabs>
                      <TabList aria-label={t("reports.timeBy")}>
                        <Tab id="teams">{t("nav.teams")}</Tab>
                        <Tab id="projects">{t("nav.projects")}</Tab>
                        <Tab id="people">{t("nav.people")}</Tab>
                        <Tab id="issues">{t("nav.issues")}</Tab>
                      </TabList>
                      {(["teams", "projects", "people", "issues"] as const).map((k) => (
                        <TabPanel key={k} id={k}>
                          {report[k].filter((r) => r.minutes > 0).length === 0 ? (
                            <p className="text-[13px] text-muted-foreground">
                              {t("reports.noTime")}
                            </p>
                          ) : (
                            <BarList
                              rows={[...report[k]]
                                .filter((r) => r.minutes > 0)
                                .sort((a, b) => b.minutes - a.minutes)
                                .slice(0, 8)
                                .map((r) => ({
                                  id: r.id,
                                  label: nameOf[k](r.id),
                                  value: r.minutes,
                                }))}
                              format={formatMinutes}
                            />
                          )}
                        </TabPanel>
                      ))}
                    </Tabs>
                  </Card>
                </div>
              </>
            )}
          </TabPanel>
          <TabPanel id="time">
            <TimeLog lang={lang} />
          </TabPanel>
        </Tabs>
      </Scroll>
    </Page>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function TimeLog({ lang }: { lang: string }) {
  const t = useI18n().t;
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
        <table className="w-full min-w-[40rem] text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
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
