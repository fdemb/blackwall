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

export function DeadlineChip({ issue, className }: { issue: Issue; className?: string }) {
  const { lang, t } = useI18n();
  const { ws } = useWorkspace();
  if (!issue.deadline) return null;
  const left = daysUntil(issue.deadline);
  const done = isDone(ws, issue);
  const tone = done ? "text-muted-foreground" : left < 0 ? "text-destructive" : left <= 2 ? "text-warning" : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs tabular-nums", tone, className)} title={left < 0 && !done ? t("deadline.overdue") : undefined}>
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
        <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">
          <LabelDot color={l.color} />
          {l.name}
        </span>
      ))}
      {labels.length > max && <span className="text-[11px] text-muted-foreground">+{labels.length - max}</span>}
    </span>
  );
}

export function AssigneeAvatar({ issue, size = 20 }: { issue: Issue; size?: number }) {
  const { member } = useWorkspace();
  const m = member(issue.assignee);
  const { t } = useI18n();
  if (!m) return <span role="img" aria-label={t("assignee.none")} title={t("assignee.none")} style={{ width: size, height: size }} className="inline-block rounded-full border border-dashed border-muted-foreground/40" />;
  return <Avatar name={m.display_name} src={m.avatar_url} size={size} named />;
}

export function BlockedBadge({ issue }: { issue: Issue }) {
  const { ws } = useWorkspace();
  const t = useI18nT();
  const open = issue.dependencies.filter((id) => {
    const d = ws.issues.find((i) => i.id === id);
    return d && !d.deleted_at && !isDone(ws, d);
  });
  if (!open.length) return null;
  return (
    <Badge tone="danger" title={t("issue.blockedBy")}>
      <Lock className="size-3" />
      {open.length}
    </Badge>
  );
}
function useI18nT() {
  return useI18n().t;
}

export function SubtaskProgress({ issue }: { issue: Issue }) {
  const { ws } = useWorkspace();
  const subs = ws.issues.filter((i) => i.parent_id === issue.id && !i.deleted_at);
  if (!subs.length) return null;
  const done = subs.filter((s) => isDone(ws, s)).length;
  return (
    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
      <Link2 className="size-3" />
      {done}/{subs.length}
    </span>
  );
}

export function useStage(issue: Issue) {
  const { ws } = useWorkspace();
  return stageOf(ws, issue);
}
