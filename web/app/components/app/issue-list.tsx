import { useMemo, useState } from "react";
import {
  Calendar,
  Collection,
  Dialog,
  DialogTrigger,
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
import { Archive, Check, ChevronDown, Flag, Minus, Trash2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/toggles";
import { CalendarBody, fromCalendarDate } from "~/components/ui/date-picker";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Popover } from "~/components/ui/popover";
import { Avatar } from "~/components/ui/avatar";
import { useToast } from "~/components/ui/toast";
import { ISSUE_DRAG_TYPE, issueDragItem, readDraggedIssues } from "./board";
import { ConfirmDialog } from "./confirm";
import {
  AssigneeMenu,
  DeadlineMenu,
  ESTIMATES,
  KeyButton,
  LabelLinks,
  PriorityMenu,
} from "./issue-menus";
import { IssuePicker } from "./issue-picker";
import { LabelDot } from "./pickers";
import { cn } from "~/lib/utils";
import { PRIORITIES, sprintLabel } from "~/lib/format";
import { useIssueKeyWidth } from "./issue-key";
import { stageOf, isDoneOnly } from "~/lib/filters";
import { milestoneGroups, projectMilestones } from "~/lib/projects";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { useIssueIntent } from "~/lib/queries";
import type { Id, Issue, IssuePatch, ListGroup, Priority } from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";
import { BlockedBadge, SubtaskProgress, TrackerBadge } from "./issue-parts";

export type GroupBy = ListGroup;

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
    if (groupBy === "milestone") {
      const ordered = ws.projects.flatMap((p) => projectMilestones(ws.milestones, p.id));
      return milestoneGroups(issues, ordered).map(({ milestone, items }) => ({
        id: milestone?.id ?? "none",
        title: milestone?.name ?? t("milestone.none"),
        icon: milestone ? (
          <Flag aria-hidden className="size-3.5 shrink-0 text-primary" />
        ) : undefined,
        items,
      }));
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
  const intent = useIssueIntent(issue.id);
  const locked = !canWrite;
  return (
    <GridListItem
      id={issue.id}
      textValue={issue.title}
      href={`/${ws.slug}/issue/${issue.ref}`}
      {...intent}
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

interface BulkOption {
  id: string;
  name: string;
  icon?: React.ReactNode;
  /** Trailing state, such as whether every selected issue has a label. */
  mark?: React.ReactNode;
}

/** One bulk bar property: a menu that applies the picked option to every selected issue. */
function BulkMenu({
  label,
  options,
  empty,
  onAction,
}: {
  label: string;
  options: BulkOption[];
  empty?: string;
  onAction: (id: string) => void;
}) {
  return (
    <MenuTrigger>
      <Button variant="ghost" size="sm">
        {label}
      </Button>
      <MenuPopover placement="top">
        <Menu
          aria-label={label}
          items={options}
          onAction={(k) => onAction(String(k))}
          renderEmptyState={() => <p className="px-2 py-1.5  text-muted-foreground">{empty}</p>}
        >
          {(o) => (
            <MenuItem id={o.id} textValue={o.name}>
              {o.icon}
              {o.name}
              {o.mark && <span className="ml-auto">{o.mark}</span>}
            </MenuItem>
          )}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

const NONE = "__none";

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
  const chosen = [...selected].flatMap((id) => byId.get(id) ?? []);
  if (chosen.length === 0) return null;
  const ids = chosen.map((i) => i.id);
  const first = chosen[0];
  const team = chosen.every((i) => i.team_id === first.team_id)
    ? ws.teams.find((tm) => tm.id === first.team_id)
    : undefined;
  const project = chosen.every((i) => i.project_id === first.project_id) ? first.project_id : null;
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
  const archivable = chosen.every((issue) => isDoneOnly(ws, issue));
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
  // A label every selected issue has is removed from all of them; any other is added to all.
  const labelled = (label: Id) => chosen.filter((i) => i.labels.includes(label)).length;
  const toggleLabel = (label: Id) =>
    update(
      labelled(label) === chosen.length
        ? { labels: { remove: [label] } }
        : { labels: { add: [label] } },
    );
  // A milestone outside the new project would be rejected, so moving issues leaves theirs.
  const setProject = (id: Id) =>
    update(
      chosen.every((i) => i.milestone_id === null || i.project_id === id)
        ? { project_id: id }
        : { project_id: id, clear_milestone: true },
    );
  const projects = ws.projects.filter((p) => chosen.every((i) => p.team_ids.includes(i.team_id)));
  const milestones = project ? ws.milestones.filter((m) => m.project_id === project) : [];
  const sprints = team
    ? ws.sprints.filter(
        (s) => s.team_id === team.id && (s.state === "planned" || s.state === "active"),
      )
    : [];
  return (
    <div
      role="toolbar"
      aria-label={t("bulk.toolbar")}
      className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 animate-in flex-wrap items-center justify-center gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-xl slide-in-from-bottom-4 fade-in-0 sm:bottom-6"
    >
      <span className="px-2.5  font-medium">{t("bulk.selected", { n: ids.length })}</span>
      <BulkMenu
        label={t("field.stage")}
        empty={t("bulk.sameTeam")}
        options={(team?.stages ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          icon: <StageIcon kind={s.kind} />,
        }))}
        onAction={(id) => update({ stage_id: id })}
      />
      <BulkMenu
        label={t("field.priority")}
        options={PRIORITIES.map((p) => ({
          id: p,
          name: t(`priority.${p}`),
          icon: <PriorityIcon priority={p} />,
        }))}
        onAction={(p) => update({ priority: p as Priority })}
      />
      <BulkMenu
        label={t("field.assignee")}
        options={[
          { id: NONE, name: t("assignee.none") },
          ...members.map((m) => ({
            id: m.id,
            name: m.display_name,
            icon: <Avatar name={m.display_name} src={m.avatar_url} size={16} />,
          })),
        ]}
        onAction={(id) => update(id === NONE ? { clear_assignee: true } : { assignee: id })}
      />
      <BulkMenu
        label={t("field.labels")}
        options={ws.labels.map((l) => {
          const count = labelled(l.id);
          return {
            id: l.id,
            name: l.name,
            icon: <LabelDot color={l.color} />,
            mark:
              count === chosen.length ? (
                <Check aria-hidden className="size-3.5 text-primary" />
              ) : count > 0 ? (
                <Minus aria-hidden className="size-3.5" />
              ) : null,
          };
        })}
        onAction={toggleLabel}
      />
      <BulkMenu
        label={t("field.project")}
        empty={t("bulk.noProjects")}
        options={[
          { id: NONE, name: t("project.none") },
          ...projects.map((p) => ({ id: p.id, name: p.name })),
        ]}
        onAction={(id) =>
          id === NONE ? update({ clear_project: true, clear_milestone: true }) : setProject(id)
        }
      />
      <BulkMenu
        label={t("field.milestone")}
        empty={t("bulk.sameProject")}
        options={
          project
            ? [
                { id: NONE, name: t("milestone.none") },
                ...milestones.map((m) => ({ id: m.id, name: m.name })),
              ]
            : []
        }
        onAction={(id) => update(id === NONE ? { clear_milestone: true } : { milestone_id: id })}
      />
      {team?.sprints !== false && (
        <BulkMenu
          label={t("field.sprint")}
          empty={t("bulk.sameTeamSprint")}
          options={
            team
              ? [
                  { id: NONE, name: t("sprint.none") },
                  ...sprints.map((s) => ({ id: s.id, name: sprintLabel(s) })),
                ]
              : []
          }
          onAction={(id) => update(id === NONE ? { clear_sprint: true } : { sprint_id: id })}
        />
      )}
      <BulkMenu
        label={t("field.estimate")}
        options={[
          { id: NONE, name: t("estimate.none") },
          ...ESTIMATES.map((v) => ({ id: String(v), name: `${v} ${t("estimate.unit")}` })),
        ]}
        onAction={(v) => update(v === NONE ? { clear_estimate: true } : { estimate: Number(v) })}
      />
      <DialogTrigger>
        <Button variant="ghost" size="sm">
          {t("field.deadline")}
        </Button>
        <Popover placement="top" className="w-auto min-w-0">
          <Dialog aria-label={t("field.deadline")} className="p-3 outline-none">
            {({ close }) => (
              <>
                <Calendar
                  aria-label={t("field.deadline")}
                  onChange={(d) => {
                    void update({ deadline: fromCalendarDate(d) ?? undefined });
                    close();
                  }}
                >
                  <CalendarBody />
                </Calendar>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onPress={() => {
                    void update({ clear_deadline: true });
                    close();
                  }}
                >
                  <X aria-hidden />
                  {t("action.clearField")}
                </Button>
              </>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
      <IssuePicker
        exclude={ids}
        onPick={(id) => void update({ parent_id: id })}
        trigger={
          <Button variant="ghost" size="sm">
            {t("issue.parent")}
          </Button>
        }
      />
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
