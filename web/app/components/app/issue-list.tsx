import { useEffect, useMemo, useState } from "react";
import {
  GridList,
  GridListItem,
  GridListHeader,
  GridListSection,
  type Selection,
} from "react-aria-components";
import { ChevronDown, Trash2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/toggles";
import { Menu, MenuItem, MenuPopover, MenuTrigger, MenuSeparator } from "~/components/ui/menu";
import { Avatar } from "~/components/ui/avatar";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "./confirm";
import { cn } from "~/lib/utils";
import { issueKey, PRIORITIES } from "~/lib/format";
import { stageOf } from "~/lib/filters";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Issue, IssueGroup, IssuePatch } from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";
import {
  AssigneeAvatar,
  BlockedBadge,
  DeadlineChip,
  LabelChips,
  SubtaskProgress,
} from "./issue-parts";

export type GroupBy = IssueGroup;

interface Group {
  id: string;
  title: string;
  icon?: React.ReactNode;
  items: Issue[];
}

export function useGroups(issues: Issue[], groupBy: GroupBy): Group[] {
  const t = useT();
  const { ws, members } = useWorkspace();
  return useMemo(() => {
    if (groupBy === "none") return [{ id: "all", title: t("group.all"), items: issues }];
    if (groupBy === "priority")
      return PRIORITIES.map((p) => ({
        id: p,
        title: t(`priority.${p}`),
        icon: <PriorityIcon priority={p} />,
        items: issues.filter((i) => i.priority === p),
      })).filter((g) => g.items.length);
    if (groupBy === "assignee") {
      const groups: Group[] = members
        .map((m) => ({
          id: m.id,
          title: m.display_name,
          icon: <Avatar name={m.display_name} src={m.avatar_url} size={16} />,
          items: issues.filter((i) => i.assignee === m.id),
        }))
        .filter((g) => g.items.length);
      const none = issues.filter((i) => !i.assignee);
      if (none.length) groups.push({ id: "none", title: t("assignee.none"), items: none });
      return groups;
    }
    // Stage: merge same-named stages across teams so cross-team lists stay compact.
    const order = new Map<string, Group>();
    const kinds = ["active", "planned", "backlog", "done", "cancelled"];
    for (const i of issues) {
      const s = stageOf(ws, i);
      const key = s ? `${s.kind}:${s.name.toLowerCase()}` : "unknown";
      if (!order.has(key))
        order.set(key, {
          id: key,
          title: s?.name ?? "?",
          icon: s ? <StageIcon kind={s.kind} /> : undefined,
          items: [],
        });
      order.get(key)!.items.push(i);
    }
    return [...order.entries()]
      .sort(([a], [b]) => kinds.indexOf(a.split(":")[0]) - kinds.indexOf(b.split(":")[0]))
      .map(([, g]) => g);
  }, [issues, groupBy, ws, members, t]);
}

export function IssueList({
  issues,
  groupBy = "stage",
  showTeam,
  emptyState,
  selectable = true,
}: {
  issues: Issue[];
  groupBy?: GroupBy;
  showTeam?: boolean;
  emptyState?: React.ReactNode;
  selectable?: boolean;
}) {
  const groups = useGroups(issues, groupBy);
  const [selected, setSelected] = useState<Set<Id>>(new Set());
  const { canWrite } = useWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const canSelect = selectable && canWrite;

  // Selection follows what is on screen. Filtering an issue out, or collapsing its group, drops it
  // from the selection, so a bulk action never touches issues the person can't see.
  const visible = useMemo(
    () =>
      new Set(groups.filter((g) => !collapsed.has(g.id)).flatMap((g) => g.items.map((i) => i.id))),
    [groups, collapsed],
  );
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  const onGroupSelection = (group: Group, sel: Selection) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of group.items) next.delete(i.id);
      const keys = sel === "all" ? group.items.map((i) => i.id) : [...sel];
      for (const k of keys) next.add(k as Id);
      return next;
    });
  };

  if (issues.length === 0) return <>{emptyState}</>;

  return (
    <div className="pb-24">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.id);
        return (
          <section key={g.id}>
            {groupBy !== "none" && (
              <button
                type="button"
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(g.id)) {
                      n.delete(g.id);
                    } else {
                      n.add(g.id);
                    }
                    return n;
                  })
                }
                aria-expanded={!isCollapsed}
                className="flex h-9 w-full items-center gap-2 border-b border-border bg-muted/40 px-4 text-left text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    isCollapsed && "-rotate-90",
                  )}
                />
                {g.icon}
                {g.title}
                <span className="text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
              </button>
            )}
            {!isCollapsed && (
              <GridList
                aria-label={g.title}
                items={g.items}
                selectionMode={canSelect ? "multiple" : "none"}
                selectionBehavior="toggle"
                selectedKeys={selected}
                onSelectionChange={(s) => onGroupSelection(g, s)}
              >
                {(issue) => <IssueRow issue={issue} showTeam={showTeam} canSelect={canSelect} />}
              </GridList>
            )}
          </section>
        );
      })}
      <BulkBar selected={selected} clear={() => setSelected(new Set())} />
    </div>
  );
}

export function IssueRow({
  issue,
  showTeam,
  canSelect,
}: {
  issue: Issue;
  showTeam?: boolean;
  canSelect?: boolean;
}) {
  const { ws, team, run, canWrite } = useWorkspace();
  const t = useT();
  const stage = stageOf(ws, issue);
  const project = ws.projects.find((p) => p.id === issue.project_id);
  return (
    <GridListItem
      id={issue.id}
      textValue={issue.title}
      href={`/${ws.id}/issue/${issue.id}`}
      className="group flex h-10 cursor-default items-center gap-2.5 border-b border-border/70 px-4 text-[13px] outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 selected:bg-accent/60"
    >
      {canSelect && (
        <Checkbox
          slot="selection"
          aria-label={t("bulk.select")}
          className="relative w-4 after:absolute after:-inset-3 after:content-[''] [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-selected:opacity-100 group-focus-visible:opacity-100 [&:has([data-selected])]:opacity-100"
        />
      )}
      <PriorityMenu
        issue={issue}
        disabled={!canWrite}
        run={(patch) => run({ type: "update_issue", id: issue.id, patch })}
      />
      <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
        {issueKey(issue.number)}
      </span>
      {stage && (
        <span title={stage.name}>
          <StageIcon kind={stage.kind} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
      <BlockedBadge issue={issue} />
      <SubtaskProgress issue={issue} />
      <span className="hidden md:block">
        <LabelChips issue={issue} />
      </span>
      {showTeam && (
        <span className="hidden text-xs text-muted-foreground lg:block">
          {team(issue.team_id)?.name}
        </span>
      )}
      {project && (
        <span className="hidden max-w-32 truncate text-xs text-muted-foreground xl:block">
          {project.name}
        </span>
      )}
      <span className="w-20 text-right">
        <DeadlineChip issue={issue} className="justify-end" />
      </span>
      <AssigneeAvatar issue={issue} />
    </GridListItem>
  );
}

function PriorityMenu({
  issue,
  disabled,
  run,
}: {
  issue: Issue;
  disabled: boolean;
  run: (p: IssuePatch) => Promise<unknown>;
}) {
  const t = useT();
  return (
    <MenuTrigger>
      <Button
        variant="ghost"
        size="icon"
        isDisabled={disabled}
        aria-label={t("field.priority")}
        className="-ml-1 size-6"
      >
        <PriorityIcon priority={issue.priority} />
      </Button>
      <MenuPopover placement="bottom start">
        <Menu
          selectionMode="single"
          selectedKeys={[issue.priority]}
          onAction={(k) => run({ priority: k as never }).catch(() => {})}
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

function BulkBar({ selected, clear }: { selected: Set<Id>; clear: () => void }) {
  const t = useT();
  const toast = useToast();
  const { ws, members, run } = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  if (selected.size === 0) return null;
  const ids = [...selected];
  const first = ws.issues.find((i) => i.id === ids[0]);
  const team = ws.teams.find((tm) => tm.id === first?.team_id);
  const same = ids.every((id) => ws.issues.find((i) => i.id === id)?.team_id === first?.team_id);
  const update = (patch: IssuePatch) =>
    run({ type: "bulk_issues", ids, action: { update: patch } })
      .then(clear)
      .catch(() => {});
  const remove = async () => {
    await run({ type: "bulk_issues", ids, action: "delete" }, { quiet: true });
    clear();
    toast.show(t("bulk.deleted", { n: ids.length }), {
      label: t("action.undo"),
      run: () =>
        void run({ type: "bulk_issues", ids, action: "restore" })
          .then(() => toast.show(t("bulk.restored", { n: ids.length })))
          .catch(() => {}),
    });
  };
  return (
    <div
      role="toolbar"
      aria-label={t("bulk.toolbar")}
      className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 animate-in flex-wrap items-center justify-center gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-xl slide-in-from-bottom-4 fade-in-0 sm:bottom-6"
    >
      <span className="px-2.5 text-[13px] font-medium">
        {t("bulk.selected", { n: ids.length })}
      </span>
      <MenuTrigger>
        <Button variant="ghost" size="sm">
          {t("field.stage")}
        </Button>
        <MenuPopover placement="top">
          <Menu
            onAction={(k) => update({ stage_id: k as Id })}
            items={same ? (team?.stages ?? []) : []}
            renderEmptyState={() => (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("bulk.sameTeam")}</p>
            )}
          >
            {(s) => (
              <MenuItem id={s.id}>
                <StageIcon kind={s.kind} />
                {s.name}
              </MenuItem>
            )}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      <MenuTrigger>
        <Button variant="ghost" size="sm">
          {t("field.priority")}
        </Button>
        <MenuPopover placement="top">
          <Menu onAction={(k) => update({ priority: k as never })}>
            {PRIORITIES.map((p) => (
              <MenuItem key={p} id={p}>
                <PriorityIcon priority={p} />
                {t(`priority.${p}`)}
              </MenuItem>
            ))}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      <MenuTrigger>
        <Button variant="ghost" size="sm">
          {t("field.assignee")}
        </Button>
        <MenuPopover placement="top">
          <Menu
            onAction={(k) =>
              k === "__none" ? update({ clear_assignee: true }) : update({ assignee: k as Id })
            }
          >
            <MenuItem id="__none">{t("assignee.none")}</MenuItem>
            <MenuSeparator />
            {members.map((m) => (
              <MenuItem key={m.id} id={m.id} textValue={m.display_name}>
                <Avatar name={m.display_name} src={m.avatar_url} size={16} />
                {m.display_name}
              </MenuItem>
            ))}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onPress={() => setConfirm(true)}
      >
        <Trash2 />
        {t("action.delete")}
      </Button>
      <Button variant="ghost" size="icon" aria-label={t("action.clear")} onPress={clear}>
        <X />
      </Button>
      <ConfirmDialog
        title={t("bulk.deleteTitle", { n: ids.length })}
        description={t("bulk.deleteSub")}
        isOpen={confirm}
        onOpenChange={setConfirm}
        onConfirm={remove}
      />
    </div>
  );
}
export { GridListHeader, GridListSection };
