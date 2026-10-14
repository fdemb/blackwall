import { Button as RACButton, Calendar, Dialog, DialogTrigger, Link } from "react-aria-components";
import { CalendarDays, Gauge, IterationCw, Link2, User, X } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { CalendarBody, fromCalendarDate, toCalendarDate } from "~/components/ui/date-picker";
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover } from "~/components/ui/popover";
import { useToast } from "~/components/ui/toast";
import { Tip } from "~/components/ui/tooltip";
import { PRIORITIES, sprintKey } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { sprintPath } from "~/lib/last-view";
import { cn } from "~/lib/utils";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Issue } from "~/lib/types";
import { PriorityIcon } from "./icons";
import { IssueKey } from "./issue-key";
import { AssigneeAvatar, DeadlineChip } from "./issue-parts";
import { useIssuePatch } from "./issue-properties";
import { LabelDot } from "./pickers";

const NONE = "__none";
export const ESTIMATES = [1, 2, 3, 5, 8, 13];

/**
 * Compact trigger for one property on a card. A disabled chip still shows its value, so it keeps
 * full contrast and only drops the hover.
 */
export const chip =
  "inline-flex h-6 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pressed:bg-foreground/10 aria-expanded:bg-foreground/10 aria-expanded:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

/** For a property the issue doesn't have yet: hidden until the card is hovered or focused. */
export const emptyChip =
  "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100";

interface MenuProps {
  issue: Issue;
  isDisabled?: boolean;
  className?: string;
}

/** The issue key. Pressing it copies a link to the issue. */
export function KeyButton({ issue, width }: { issue: Issue; width?: string }) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  const toast = useToast();
  const copy = () =>
    void navigator.clipboard
      .writeText(`${window.location.origin}/${ws.slug}/issue/${issue.ref}`)
      .then(() => toast.show(t("issue.linkCopied")));
  return (
    <Tip label={t("issue.copyLink")}>
      <RACButton
        onPress={copy}
        aria-label={`${t("issue.copyLink")}: ${issue.key}`}
        className={cn(chip, "group/key -ml-1.5 h-5 gap-1 px-1.5")}
      >
        <IssueKey value={issue.key} width={width} />
        <Link2
          aria-hidden
          className="size-3 opacity-0 transition-opacity group-hover/key:opacity-100 group-focus-visible/key:opacity-100"
        />
      </RACButton>
    </Tip>
  );
}

export function PriorityMenu({ issue, isDisabled, className }: MenuProps) {
  const { t } = useI18n();
  const patch = useIssuePatch(issue);
  return (
    <MenuTrigger>
      <Tip label={`${t("field.priority")}: ${t(`priority.${issue.priority}`)}`}>
        <Button
          variant="ghost"
          size="icon"
          isDisabled={isDisabled}
          aria-label={t("field.priority")}
          className={cn("size-6 disabled:opacity-100", className)}
        >
          <PriorityIcon priority={issue.priority} />
        </Button>
      </Tip>
      <MenuPopover placement="bottom start">
        <Menu
          aria-label={t("field.priority")}
          selectionMode="single"
          selectedKeys={[issue.priority]}
          onAction={(k) => void patch({ priority: k as Issue["priority"] })}
        >
          {PRIORITIES.map((p) => (
            <MenuItem key={p} id={p} textValue={t(`priority.${p}`)}>
              <PriorityIcon priority={p} />
              {t(`priority.${p}`)}
            </MenuItem>
          ))}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

export function AssigneeMenu({ issue, isDisabled, className }: MenuProps) {
  const { t } = useI18n();
  const { members, member, team } = useWorkspace();
  const patch = useIssuePatch(issue);
  const current = member(issue.assignee);
  const ids = new Set(team(issue.team_id)?.members ?? []);
  const pool = members.filter((m) => ids.size === 0 || ids.has(m.id) || m.id === issue.assignee);
  const label = current?.display_name ?? t("assignee.none");
  return (
    <MenuTrigger>
      <Tip label={label}>
        <RACButton
          isDisabled={isDisabled}
          aria-label={`${t("field.assignee")}: ${label}`}
          className={cn(
            "inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-full outline-none transition-[box-shadow] hover:ring-2 hover:ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:hover:ring-0",
            className,
          )}
        >
          <AssigneeAvatar issue={issue} size={20} />
        </RACButton>
      </Tip>
      <MenuPopover placement="bottom end">
        <Menu
          aria-label={t("field.assignee")}
          selectionMode="single"
          selectedKeys={[issue.assignee ?? NONE]}
          onAction={(k) =>
            void patch(k === NONE ? { clear_assignee: true } : { assignee: k as Id })
          }
        >
          <MenuItem id={NONE} textValue={t("assignee.none")}>
            <User />
            {t("assignee.none")}
          </MenuItem>
          <MenuSeparator />
          {pool.map((m) => (
            <MenuItem key={m.id} id={m.id} textValue={m.display_name}>
              <Avatar name={m.display_name} src={m.avatar_url} size={16} />
              {m.display_name}
            </MenuItem>
          ))}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

/** The issue's labels as chips. Each links to all issues with that label. */
export function LabelLinks({ issue, className }: { issue: Issue; className?: string }) {
  const { ws } = useWorkspace();
  const labels = ws.labels.filter((l) => issue.labels.includes(l.id));
  if (!labels.length) return null;
  const max = 3;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {labels.slice(0, max).map((l) => (
        <Link
          key={l.id}
          href={`/${ws.slug}/issues?label=${l.id}`}
          className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground outline-none transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <LabelDot color={l.color} />
          {l.name}
        </Link>
      ))}
      {labels.length > max && (
        <span className="text-[11px] text-muted-foreground">+{labels.length - max}</span>
      )}
    </span>
  );
}

/** The issue's sprint key. Links to the sprint. */
export function SprintLink({ issue, className }: { issue: Issue; className?: string }) {
  const { t } = useI18n();
  const { ws, team } = useWorkspace();
  const sprint = ws.sprints.find((s) => s.id === issue.sprint_id);
  const teamKey = sprint && team(sprint.team_id)?.key;
  if (!sprint || !teamKey) return null;
  const label = `${t("field.sprint")}: ${sprint.name}`;
  return (
    <Tip label={label}>
      <Link
        href={sprintPath(ws.slug, teamKey, sprint)}
        aria-label={label}
        className={cn(chip, className)}
      >
        <IterationCw aria-hidden className="size-3.5" />
        {sprintKey(sprint.number)}
      </Link>
    </Tip>
  );
}

export function DeadlineMenu({ issue, isDisabled, className }: MenuProps) {
  const { t } = useI18n();
  const patch = useIssuePatch(issue);
  if (!issue.deadline && isDisabled) return null;
  return (
    <DialogTrigger>
      <Tip label={t("field.deadline")}>
        <RACButton
          isDisabled={isDisabled}
          aria-label={t("field.deadline")}
          className={cn(chip, !issue.deadline && emptyChip, className)}
        >
          {issue.deadline ? (
            <DeadlineChip issue={issue} />
          ) : (
            <CalendarDays aria-hidden className="size-3.5" />
          )}
        </RACButton>
      </Tip>
      <Popover placement="bottom start" className="w-auto min-w-0">
        <Dialog aria-label={t("field.deadline")} className="p-3 outline-none">
          {({ close }) => (
            <>
              <Calendar
                aria-label={t("field.deadline")}
                value={toCalendarDate(issue.deadline)}
                onChange={(d) => {
                  void patch({ deadline: fromCalendarDate(d) ?? undefined });
                  close();
                }}
              >
                <CalendarBody />
              </Calendar>
              {issue.deadline && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onPress={() => {
                    void patch({ clear_deadline: true });
                    close();
                  }}
                >
                  <X aria-hidden />
                  {t("action.clearField")}
                </Button>
              )}
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

export function EstimateMenu({ issue, isDisabled, className }: MenuProps) {
  const { t } = useI18n();
  const patch = useIssuePatch(issue);
  const values =
    issue.estimate && !ESTIMATES.includes(issue.estimate)
      ? [...ESTIMATES, issue.estimate].sort((a, b) => a - b)
      : ESTIMATES;
  if (!issue.estimate && isDisabled) return null;
  return (
    <MenuTrigger>
      <Tip label={t("field.estimate")}>
        <RACButton
          isDisabled={isDisabled}
          aria-label={t("field.estimate")}
          className={cn(chip, !issue.estimate && emptyChip, className)}
        >
          <Gauge aria-hidden className="size-3.5" />
          {issue.estimate ? `${issue.estimate} ${t("estimate.unit")}` : null}
        </RACButton>
      </Tip>
      <MenuPopover placement="bottom start">
        <Menu
          aria-label={t("field.estimate")}
          selectionMode="single"
          selectedKeys={[issue.estimate ? String(issue.estimate) : NONE]}
          onAction={(k) =>
            void patch(k === NONE ? { clear_estimate: true } : { estimate: Number(k) })
          }
        >
          <MenuItem id={NONE} textValue={t("estimate.none")}>
            {t("estimate.none")}
          </MenuItem>
          <MenuSeparator />
          {values.map((v) => (
            <MenuItem key={v} id={String(v)} textValue={String(v)}>
              <span className="tabular-nums">
                {v} {t("estimate.unit")}
              </span>
            </MenuItem>
          ))}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}
