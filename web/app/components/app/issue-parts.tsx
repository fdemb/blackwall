import { CalendarDays, ExternalLink, Link2, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import { daysUntil, shortDate } from "~/lib/format";
import { isDone, stageOf } from "~/lib/filters";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Issue } from "~/lib/types";
import { LabelDot } from "./pickers";
import { syncIssueUrl, syncProviderName, syncPushError } from "~/lib/sync";

export function SyncBadge({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  if (!issue.sync) return null;
  const provider = syncProviderName(issue.sync.provider);
  const failed = syncPushError(issue) !== null;
  return (
    <span
      title={failed ? t("sync.pushFailedShort", { provider }) : t("sync.syncedWith", { provider })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px]",
        failed
          ? "text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]"
          : "text-muted-foreground",
      )}
    >
      {failed ? (
        <TriangleAlert aria-hidden className="size-3" />
      ) : (
        <RefreshCw aria-hidden className="size-3" />
      )}
      <span className="sr-only sm:not-sr-only">{provider}</span>
    </span>
  );
}

/** Where a synced issue lives remotely and whether the last change made it there. */
export function SyncNotice({ issue }: { issue: Pick<Issue, "sync"> }) {
  const { t } = useI18n();
  if (!issue.sync) return null;
  const provider = syncProviderName(issue.sync.provider);
  const url = syncIssueUrl(issue);
  const error = syncPushError(issue);
  const label = t("sync.syncedWith", { provider });
  return (
    <div className="mb-4 space-y-1.5 text-xs text-muted-foreground">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 hover:text-foreground"
        >
          <RefreshCw aria-hidden className="size-3" />
          {label}
          <ExternalLink aria-hidden className="size-3" />
        </a>
      ) : (
        <p className="inline-flex items-center gap-1.5">
          <RefreshCw aria-hidden className="size-3" />
          {label}
        </p>
      )}
      {error ? (
        <p
          role="status"
          className="flex items-start gap-1.5 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]"
        >
          <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
          <span className="break-words">{t("sync.pushFailed", { provider, error })}</span>
        </p>
      ) : null}
    </div>
  );
}

export function DeadlineChip({ issue, className }: { issue: Issue; className?: string }) {
  const { lang, t } = useI18n();
  const { ws } = useWorkspace();
  if (!issue.deadline) return null;
  const left = daysUntil(issue.deadline);
  const done = isDone(ws, issue);
  const tone = done
    ? "text-muted-foreground"
    : left < 0
      ? "text-destructive"
      : left <= 2
        ? "text-warning"
        : "text-muted-foreground";
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs tabular-nums", tone, className)}
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
    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
      <Link2 className="size-3" />
      {issue.subtask_completed}/{issue.subtask_total}
    </span>
  );
}

export function useStage(issue: Issue) {
  const { ws } = useWorkspace();
  return stageOf(ws, issue);
}
