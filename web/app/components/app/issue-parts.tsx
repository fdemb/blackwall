import { CalendarDays, Link2, Lock } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import { daysUntil, shortDate } from "~/lib/format";
import { isDone, stageOf } from "~/lib/filters";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Issue } from "~/lib/types";
import { LabelDot } from "./pickers";
import { isImportedIssue, openprojectIssueUrl } from "~/lib/openproject";

export function OpenProjectBadge({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  if (!isImportedIssue(issue)) return null;
  return (
    <span title={t("openproject.readonly")} className="shrink-0 text-[11px] text-muted-foreground">
      <Lock aria-hidden className="inline size-3" />{" "}
      <span className="hidden sm:inline">{t("openproject.badge")}</span>
    </span>
  );
}

export function OpenProjectNotice({ issue }: { issue: Pick<Issue, "openproject"> }) {
  const { t } = useI18n();
  if (!isImportedIssue(issue)) return null;
  const url = openprojectIssueUrl(issue);
  return (
    <div className="mb-5 space-y-2 rounded-lg border border-border bg-muted/40 p-3 ">
      <p>{t("openproject.readonly")}</p>
      {issue.openproject?.unavailable ? (
        <p className="text-muted-foreground">{t("openproject.unavailable")}</p>
      ) : null}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline underline-offset-2"
        >
          {t("openproject.open")}
        </a>
      ) : null}
    </div>
  );
}

/** Overdue reads as an error and the last two days as a warning. */
function deadlineTone(daysLeft: number): string {
  if (daysLeft < 0) return "text-destructive";
  if (daysLeft <= 2) return "text-warning";
  return "text-muted-foreground";
}

export function DeadlineChip({ issue, className }: { issue: Issue; className?: string }) {
  const { lang, t } = useI18n();
  const { ws } = useWorkspace();
  if (!issue.deadline) return null;
  const left = daysUntil(issue.deadline);
  const done = isDone(ws, issue);
  const tone = done ? "text-muted-foreground" : deadlineTone(left);
  return (
    <span
      className={cn("inline-flex items-center gap-1  tabular-nums", tone, className)}
      title={left < 0 && !done ? t("deadline.overdue") : undefined}
    >
      <CalendarDays className="size-3" />
      {shortDate(issue.deadline, lang)}
    </span>
  );
}

export function LabelChips({ issue, max = 3 }: { issue: Issue; max?: number }) {
  const { ws } = useWorkspace();
  const labels = ws.labels.filter((l) => issue.labels.includes(l.id));
  if (!labels.length) return null;
  return (
    <span className="flex items-center gap-1">
      {labels.slice(0, max).map((l) => (
        <span
          key={l.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground"
        >
          <LabelDot color={l.color} />
          {l.name}
        </span>
      ))}
      {labels.length > max && (
        <span className="text-[11px] text-muted-foreground">+{labels.length - max}</span>
      )}
    </span>
  );
}

export function AssigneeAvatar({ issue, size = 20 }: { issue: Issue; size?: number }) {
  const { member } = useWorkspace();
  const m = member(issue.assignee);
  const { t } = useI18n();
  if (!m)
    return (
      <span
        role="img"
        aria-label={t("assignee.none")}
        title={t("assignee.none")}
        style={{ width: size, height: size }}
        className="inline-block rounded-full border border-dashed border-muted-foreground/40"
      />
    );
  return <Avatar name={m.display_name} src={m.avatar_url} size={size} named />;
}

export function BlockedBadge({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  if (!issue.blocked_count) return null;
  return (
    <Badge tone="danger" title={t("issue.blockedBy")}>
      <Lock className="size-3" />
      {issue.blocked_count}
    </Badge>
  );
}
export function SubtaskProgress({ issue }: { issue: Issue }) {
  if (!issue.subtask_total) return null;
  return (
    <span className="inline-flex items-center gap-1  tabular-nums text-muted-foreground">
      <Link2 className="size-3" />
      {issue.subtask_completed}/{issue.subtask_total}
    </span>
  );
}

export function useStage(issue: Issue) {
  const { ws } = useWorkspace();
  return stageOf(ws, issue);
}
