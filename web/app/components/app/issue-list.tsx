import { useMemo, useState } from "react";
import {
  Collection,
  GridList,
  GridListHeader,
  GridListItem,
  GridListSection,
  Link,
  ListLayout,
  useDragAndDrop,
  Virtualizer,
  type Selection,
} from "react-aria-components";
import { Archive, ChevronDown, Trash2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/toggles";
import { Menu, MenuItem, MenuPopover, MenuTrigger, MenuSeparator } from "~/components/ui/menu";
import { Avatar } from "~/components/ui/avatar";
import { useToast } from "~/components/ui/toast";
import { ISSUE_DRAG_TYPE, issueDragItem, readDraggedIssues } from "./board";
import { ConfirmDialog } from "./confirm";
import { AssigneeMenu, DeadlineMenu, KeyButton, LabelLinks, PriorityMenu } from "./issue-menus";
import { cn } from "~/lib/utils";
import { PRIORITIES } from "~/lib/format";
import { useIssueKeyWidth } from "./issue-key";
import { stageOf, isDoneOnly } from "~/lib/filters";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Issue, IssueGroup, IssuePatch } from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";
import { BlockedBadge, SubtaskProgress, TrackerBadge } from "./issue-parts";

export type GroupBy = IssueGroup;

interface Group {
  id: string;
  title: string;
  icon?: React.ReactNode;
  items: Issue[];
}

/** Rank of a stage kind for group ordering. Precomputed so sorting groups never scans per compare. */
const GROUP_KIND_RANK = new Map(
  ["active", "planned", "backlog", "done", "cancelled"].map((k, i) => [k, i]),
);
const groupRankOf = (key: string) => GROUP_KIND_RANK.get(key.split(":")[0]) ?? 99;

export function useGroups(issues: Issue[], groupBy: GroupBy): Group[] {
  const { t } = useI18n();
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
    return [...order.values()].sort((a, b) => groupRankOf(a.id) - groupRankOf(b.id));
  }, [issues, groupBy, ws, members, t]);
}

/** Row and group heading heights. The virtualizer positions rows from these, so CSS must match. */
const ROW_HEIGHT = 40;
const HEADING_HEIGHT = 36;
const LAYOUT_OPTIONS = { rowSize: ROW_HEIGHT, headingSize: HEADING_HEIGHT };

/**
 * Issues in one grid, grouped into collapsible sections.
 * `fill` makes the list its own scroll area and renders only the rows in view, for full-page
 * lists that can hold thousands of issues. Without it the list grows with its content.
 */
export function IssueList({
  issues,
  groupBy = "stage",
  showTeam,
  emptyState,
  selectable = true,
  fill = false,
  selectionBar,
  onDropIssues,
}: IssueListProps & { fill?: boolean }) {
  const List = fill ? FillIssueList : PlainIssueList;
  return (
    <List
      issues={issues}
      groupBy={groupBy}
      showTeam={showTeam}
      emptyState={emptyState}
      selectable={selectable}
      selectionBar={selectionBar}
      onDropIssues={onDropIssues}
    />
  );
}

interface IssueListProps {
  issues: Issue[];
  groupBy?: GroupBy;
  showTeam?: boolean;
  emptyState?: React.ReactNode;
  selectable?: boolean;
  /** Replaces the floating bulk bar, for pages with more than one list. Gets the selected ids. */
  selectionBar?: (ids: Id[], clear: () => void) => React.ReactNode;
  /**
   * Makes rows draggable and the list a drop target for issues dragged from another list. The
   * list keeps no order of its own, so a drop lands on the list, not between rows.
   */
  onDropIssues?: (ids: Id[]) => void;
}

/** Grows with its content. For dialogs, drawers and short lists. */
export function PlainIssueList({
  issues,
  groupBy = "stage",
  showTeam,
  emptyState,
  selectable = true,
  selectionBar,
  onDropIssues,
}: IssueListProps) {
  const { grid, bar } = useIssueGrid({
    issues,
    groupBy,
    showTeam,
    emptyState,
    selectable,
    selectionBar,
    onDropIssues,
    fill: false,
  });
  // A drop target stays on screen when empty, with the empty state inside it.
  if (issues.length === 0 && !onDropIssues) return <>{emptyState}</>;
  return (
    <>
      {grid}
      {bar}
    </>
  );
}

/** Own scroll area with row virtualization. For full-page lists with thousands of issues. */
export function FillIssueList({
  issues,
  groupBy = "stage",
  showTeam,
  emptyState,
  selectable = true,
  selectionBar,
  onDropIssues,
}: IssueListProps) {
  const { grid, bar } = useIssueGrid({
    issues,
    groupBy,
    showTeam,
    emptyState,
    selectable,
    selectionBar,
    onDropIssues,
    fill: true,
  });
  if (issues.length === 0 && !onDropIssues) return <>{emptyState}</>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {issues.length === 0 ? (
        grid
      ) : (
        <Virtualizer layout={ListLayout} layoutOptions={LAYOUT_OPTIONS}>
          {grid}
        </Virtualizer>
      )}
      {bar}
    </div>
  );
}

function useIssueGrid({
  issues,
  groupBy,
  showTeam,
  emptyState,
  selectable,
  selectionBar,
  onDropIssues,
  fill,
}: Required<Pick<IssueListProps, "issues" | "groupBy" | "selectable">> &
  Pick<IssueListProps, "showTeam" | "emptyState" | "selectionBar" | "onDropIssues"> & {
    fill: boolean;
  }) {
  const { t } = useI18n();
  const groups = useGroups(issues, groupBy);
  const keyWidth = useIssueKeyWidth(issues);
  const [selected, setSelected] = useState<Set<Id>>(() => new Set());
  const { canWrite } = useWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const canSelect = selectable && canWrite;

  // Selection follows what is on screen. Filtering an issue out, or collapsing its group, drops it
  // from the selection, so a bulk action never touches issues the person can't see.
  const visible = useMemo(
    () =>
      new Set(groups.filter((g) => !collapsed.has(g.id)).flatMap((g) => g.items.map((i) => i.id))),
    [groups, collapsed],
  );
  const visibleSelected = useMemo(
    () => new Set([...selected].filter((id) => visible.has(id))),
    [selected, visible],
  );

  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: !canSelect,
    // Dragging a selected row carries the whole selection.
    getItems: (keys) =>
      [...keys].filter((k) => visible.has(String(k))).map((k) => issueDragItem(String(k), "list")),
    acceptedDragTypes: [ISSUE_DRAG_TYPE],
    // Rows refuse, so the drop falls through to the list. Drops from this list itself never count.
    getDropOperation: (target) => (target.type === "root" ? "move" : "cancel"),
    onRootDrop: async (e) => {
      const { ids } = await readDraggedIssues(e.items);
      if (ids.length) onDropIssues?.(ids);
    },
  });

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const grid = (
    <GridList
      aria-label={t("nav.issues")}
      selectionMode={canSelect ? "multiple" : "none"}
      selectionBehavior="toggle"
      selectedKeys={visibleSelected}
      onSelectionChange={(s: Selection) =>
        setSelected(new Set(s === "all" ? visible : ([...s] as Id[])))
      }
      dragAndDropHooks={onDropIssues ? dragAndDropHooks : undefined}
      renderEmptyState={() => emptyState}
      className={cn(
        "outline-none transition-colors drop-target:bg-accent/40 drop-target:ring-2 drop-target:ring-inset drop-target:ring-primary/40",
        fill && "min-h-0 flex-1 overflow-y-auto",
        // Room for the bulk bar, which floats over the end of the list.
        !fill && !selectionBar && visibleSelected.size > 0 && "pb-24",
      )}
    >
      {groupBy === "none" ? (
        <IssueRows items={issues} showTeam={showTeam} canSelect={canSelect} keyWidth={keyWidth} />
      ) : (
        groups.map((g) => {
          const isCollapsed = collapsed.has(g.id);
          return (
            <GridListSection key={g.id} id={g.id} aria-label={g.title}>
              <GridListHeader>
                <button
                  type="button"
                  onClick={() => toggle(g.id)}
                  aria-expanded={!isCollapsed}
                  className="flex h-9 w-full items-center gap-2 border-b border-border bg-muted/40 px-4 text-left  font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                >
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-3.5 text-muted-foreground transition-transform",
                      isCollapsed && "-rotate-90",
                    )}
                  />
                  {g.icon}
                  {g.title}
                  <span className=" tabular-nums text-muted-foreground">{g.items.length}</span>
                </button>
              </GridListHeader>
              <IssueRows
                items={isCollapsed ? [] : g.items}
                keyWidth={keyWidth}
                showTeam={showTeam}
                canSelect={canSelect}
              />
            </GridListSection>
          );
        })
      )}
    </GridList>
  );

  const clear = () => setSelected(new Set());
  const bar = selectionBar ? (
    selectionBar([...visibleSelected], clear)
  ) : (
    <BulkBar issues={issues} selected={visibleSelected} clear={clear} />
  );
  return { grid, bar };
}

/** Hoisted so the row collection keeps its identity across parent renders. */
function IssueRows({
  items,
  showTeam,
  canSelect,
  keyWidth,
}: {
  items: Issue[];
  showTeam?: boolean;
  canSelect?: boolean;
  keyWidth: string | undefined;
}) {
  return (
    <Collection items={items} dependencies={[keyWidth, showTeam, canSelect]}>
      {(issue) => (
        <IssueRow issue={issue} showTeam={showTeam} canSelect={canSelect} keyWidth={keyWidth} />
      )}
    </Collection>
  );
}

export function IssueRow({
  issue,
  showTeam,
  canSelect,
  keyWidth,
}: {
  issue: Issue;
  showTeam?: boolean;
  canSelect?: boolean;
  keyWidth?: string;
}) {
  const { ws, canWrite } = useWorkspace();
  const stage = stageOf(ws, issue);
  const project = ws.projects.find((p) => p.id === issue.project_id);
  const locked = !canWrite;
  return (
    <GridListItem
      id={issue.id}
      textValue={issue.title}
      href={`/${ws.slug}/issue/${issue.ref}`}
      className="group flex h-10 cursor-default items-center gap-2.5 border-b border-border/70 px-4  outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 selected:bg-accent/60"
    >
      {canSelect && <RowSelectBox />}
      <PriorityMenu issue={issue} isDisabled={locked} className="-ml-1" />
      <KeyButton issue={issue} width={keyWidth} />
      {stage && (
        <span title={stage.name}>
          <StageIcon kind={stage.kind} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
      <TrackerBadge issue={issue} />
      <BlockedBadge issue={issue} />
      <span className="hidden sm:block">
        <SubtaskProgress issue={issue} />
      </span>
      <span className="hidden md:block">
        <LabelLinks issue={issue} className="flex-nowrap" />
      </span>
      {showTeam && <TeamCell issue={issue} />}
      {project && (
        <Link
          href={`/${ws.slug}/projects/${project.id}`}
          className="hidden max-w-32 cursor-default truncate rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 xl:block"
        >
          {project.name}
        </Link>
      )}
      <span className="flex justify-end sm:w-20">
        <DeadlineMenu issue={issue} isDisabled={locked} />
      </span>
      <AssigneeMenu issue={issue} isDisabled={locked} />
    </GridListItem>
  );
}

/** The row's selection checkbox. Separated so `IssueRow` stays a pure composition of pieces. */
function RowSelectBox() {
  const { t } = useI18n();
  return (
    <Checkbox
      slot="selection"
      aria-label={t("bulk.select")}
      className="relative w-4 after:absolute after:-inset-3 after:content-[''] [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-selected:opacity-100 group-focus-visible:opacity-100 [&:has([data-selected])]:opacity-100"
    />
  );
}

/** Team name cell. Renders nothing when the issue has no resolvable team. */
export function TeamCell({ issue }: { issue: Issue }) {
  const { team } = useWorkspace();
  const name = team(issue.team_id)?.name;
  if (!name) return null;
  return <span className="hidden  text-muted-foreground lg:block">{name}</span>;
}

function BulkBar({
  issues,
  selected,
  clear,
}: {
  issues: Issue[];
  selected: Set<Id>;
  clear: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { ws, members, run } = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i] as const)), [issues]);
  const ids = [...selected].filter((id) => byId.has(id));
  if (ids.length === 0) return null;
  const first = byId.get(ids[0]);
  const team = ws.teams.find((tm) => tm.id === first?.team_id);
  const same = ids.every((id) => byId.get(id)?.team_id === first?.team_id);
  const update = (patch: IssuePatch) =>
    run({ type: "bulk_issues", ids, action: { update: patch } })
      .then(clear)
      .catch(() => {});
  const remove = async () => {
    await run({ type: "bulk_issues", ids, action: "delete" }, { quiet: true });
    clear();
    toast.show(t("bulk.deleted", { count: ids.length }), {
      label: t("action.undo"),
      run: () =>
        void run({ type: "bulk_issues", ids, action: "restore" })
          .then(() => toast.show(t("bulk.restored", { count: ids.length })))
          .catch(() => {}),
    });
  };
  // Only Done issues can be archived; the server rejects anything else.
  const archivable = ids.every((id) => {
    const issue = byId.get(id);
    return issue && isDoneOnly(ws, issue);
  });
  const archive = async () => {
    await run({ type: "bulk_issues", ids, action: "archive" }, { quiet: true });
    clear();
    toast.show(t("bulk.archived", { count: ids.length }), {
      label: t("action.undo"),
      run: () =>
        void run({ type: "bulk_issues", ids, action: "unarchive" })
          .then(() => toast.show(t("bulk.unarchived", { count: ids.length })))
          .catch(() => {}),
    });
  };
  return (
    <div
      role="toolbar"
      aria-label={t("bulk.toolbar")}
      className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 animate-in flex-wrap items-center justify-center gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-xl slide-in-from-bottom-4 fade-in-0 sm:bottom-6"
    >
      <span className="px-2.5  font-medium">{t("bulk.selected", { n: ids.length })}</span>
      <MenuTrigger>
        <Button variant="ghost" size="sm">
          {t("field.stage")}
        </Button>
        <MenuPopover placement="top">
          <Menu
            onAction={(k) => update({ stage_id: k as Id })}
            items={same ? (team?.stages ?? []) : []}
            renderEmptyState={() => (
              <p className="px-2 py-1.5  text-muted-foreground">{t("bulk.sameTeam")}</p>
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
        <Trash2 aria-hidden />
        {t("action.delete")}
      </Button>
      {archivable && (
        <Button variant="ghost" size="sm" onPress={() => void archive()}>
          <Archive aria-hidden />
          {t("action.archive")}
        </Button>
      )}
      <Button variant="ghost" size="icon" aria-label={t("action.clear")} onPress={clear}>
        <X aria-hidden />
      </Button>
      <ConfirmDialog
        title={t("bulk.deleteTitle", { count: ids.length })}
        description={t("bulk.deleteSub")}
        isOpen={confirm}
        onOpenChange={setConfirm}
        onConfirm={remove}
      />
    </div>
  );
}
