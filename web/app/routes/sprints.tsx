import { useState } from "react";
import { Link } from "react-router";
import { Archive, CalendarRange, ListChecks, Plus, Target } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Page, PageHeader, Card, EmptyState, TeamCrumb } from "~/components/app/page";
import { SprintForm, SprintMenu } from "~/components/app/sprint-actions";
import { fullDate, shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { cn } from "~/lib/utils";
import { useSprintProgress } from "~/lib/stats";
import { useWorkspace } from "~/lib/workspace";
import type { Sprint } from "~/lib/types";
import { useTeamContext } from "./team";

/**
 * A row opens its sprint from anywhere on it: the name's link stretches over the row, and the
 * row's own controls sit above that.
 */
const ROW = "relative px-4 hover:bg-muted/50 focus-within:bg-muted/50";
const STRETCHED_LINK =
  "truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline";
const ABOVE_LINK = "relative z-10";

export default function Sprints() {
  const { t, lang } = useI18n();
  const { team: tm } = useTeamContext();
  const { ws, run, canWrite } = useWorkspace();
  const progress = useSprintProgress();
  const [creating, setCreating] = useState(false);
  const { pending: archiving, guard } = usePending();
  const pageOf = (s: Sprint) => `/${ws.id}/team/${tm.id}/sprints/${s.id}`;
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

  return (
    <Page>
      <PageHeader
        title={`${tm.name}: ${t("team.sprints")}`}
        heading={
          <h1 className="mr-2 flex min-w-0 items-center gap-2">
            <TeamCrumb team={tm} wsId={ws.id} />
            <span aria-hidden="true" className="text-muted-foreground/50">
              /
            </span>
            <span className="truncate font-medium">{t("team.sprints")}</span>
          </h1>
        }
        actions={
          canWrite && (
            <Button variant="primary" size="sm" onPress={() => setCreating(true)}>
              <Plus />
              {t("sprint.new")}
            </Button>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {sprints.length === 0 && (
          <EmptyState
            icon={<CalendarRange />}
            title={t("sprint.emptyTitle")}
            description={t("sprint.emptySub")}
          />
        )}
        {open.length > 0 && (
          <section className="px-4 pt-4 pb-4">
            <Card className="divide-y divide-border overflow-hidden">
              {open.map((s) => {
                const stats = progress.get(s.id);
                return (
                  <div key={s.id} className={cn(ROW, "py-3")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={pageOf(s)} className={STRETCHED_LINK}>
                        {s.name}
                      </Link>
                      <Badge tone={s.state === "active" ? "primary" : "neutral"}>
                        {t(`sprint.state.${s.state}`)}
                      </Badge>
                      <Link
                        to={`${pageOf(s)}/plan`}
                        className={buttonVariants({
                          variant: "ghost",
                          size: "sm",
                          className: cn(ABOVE_LINK, "ml-auto"),
                        })}
                      >
                        <ListChecks />
                        {t("sprint.plan")}
                      </Link>
                      <SprintMenu sprint={s} className={ABOVE_LINK} />
                    </div>
                    <SprintSummary
                      sprint={s}
                      done={stats?.completed ?? 0}
                      total={stats?.total ?? 0}
                    />
                  </div>
                );
              })}
            </Card>
          </section>
        )}

        {past.length > 0 && (
          <section className="px-4 pt-4 pb-8">
            <h2 className="mb-2  font-semibold">{t("sprint.past")}</h2>
            <Card className="divide-y divide-border overflow-hidden">
              {past.map((s) => (
                <div
                  key={s.id}
                  className={cn(ROW, "flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5")}
                >
                  <Link to={pageOf(s)} className={STRETCHED_LINK}>
                    {s.name}
                  </Link>
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
                  {canWrite && s.state === "completed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      isDisabled={archiving}
                      className={cn(ABOVE_LINK, !s.outcome && "ml-auto")}
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
        title={t("sprint.new")}
        size="sm"
        isOpen={creating}
        onOpenChange={(o) => !o && setCreating(false)}
      >
        {(close) => <SprintForm teamId={tm.id} sprint={null} close={close} />}
      </Dialog>
    </Page>
  );
}

/** Goal, dates and progress under a sprint's name. */
function SprintSummary({ sprint, done, total }: { sprint: Sprint; done: number; total: number }) {
  const { t, lang } = useI18n();
  return (
    <div className="mt-1.5 max-w-xl space-y-1.5 text-muted-foreground">
      {sprint.goal && (
        <p className="flex gap-1.5 text-foreground">
          <Target className="mt-0.5 size-3.5 shrink-0 text-primary" />
          {sprint.goal}
        </p>
      )}
      <p className="tabular-nums">
        {shortDate(sprint.starts_at, lang)} – {shortDate(sprint.ends_at, lang)} ·{" "}
        {t("sprint.progress", { done, total })}
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}
