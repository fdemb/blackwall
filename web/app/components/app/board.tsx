import { useCallback } from "react";
import {
  DropIndicator,
  ListBox,
  ListBoxItem,
  ListLayout,
  useDragAndDrop,
  Virtualizer,
  type DropTarget,
} from "react-aria-components";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { issueKey } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Issue } from "~/lib/types";
import { PriorityIcon } from "./icons";
import {
  AssigneeAvatar,
  BlockedBadge,
  DeadlineChip,
  LabelChips,
  SubtaskProgress,
} from "./issue-parts";

const TYPE = "application/x-blackwall-issue";

/**
 * Columns render only the cards in view. Cards vary in height, so the layout starts from an
 * estimate and measures each card; gap and padding replace the column's CSS spacing.
 */
const COLUMN_LAYOUT = { estimatedRowSize: 92, gap: 6, padding: 6, dropIndicatorThickness: 2 };

export interface DndColumnProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  count?: number;
  issues: Issue[];
  onDrop: (ids: Id[], beforeId: Id | null, source: Id | null) => void;
  onCreate?: () => void;
  canDrop?: boolean;
  className?: string;
  aside?: React.ReactNode;
  emptyText?: string;
  footer?: React.ReactNode;
}

export function DndColumn({
  id,
  title,
  icon,
  count,
  issues,
  onDrop,
  onCreate,
  canDrop = true,
  className,
  aside,
  emptyText,
  footer,
}: DndColumnProps) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  const beforeFor = useCallback(
    (target: DropTarget): Id | null => {
      if (target.type !== "item") return null;
      const index = issues.findIndex((i) => i.id === target.key);
      if (index < 0) return null;
      return target.dropPosition === "before" ? issues[index].id : (issues[index + 1]?.id ?? null);
    },
    [issues],
  );
  const read = useCallback(
    async (items: { kind: string; getText?: (t: string) => Promise<string> }[]) => {
      const ids: Id[] = [];
      let source: Id | null = null;
      for (const item of items) {
        if (item.kind !== "text" || !item.getText) continue;
        try {
          const data = JSON.parse(await item.getText(TYPE)) as { id: Id; column: string };
          ids.push(data.id);
          source = data.column;
        } catch {
          /* not ours */
        }
      }
      return { ids, source };
    },
    [],
  );
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: !canWrite || !canDrop,
    getItems: (keys) =>
      [...keys].map((k) => ({
        [TYPE]: JSON.stringify({ id: k, column: id }),
        "text/plain": String(k),
      })),
    acceptedDragTypes: [TYPE],
    getDropOperation: () => "move",
    onInsert: async (e) => {
      const { ids, source } = await read(e.items as never);
      onDrop(ids, beforeFor(e.target), source);
    },
    onReorder: (e) => onDrop([...e.keys] as Id[], beforeFor(e.target), id),
    onRootDrop: async (e) => {
      const { ids, source } = await read(e.items as never);
      onDrop(ids, null, source);
    },
    renderDropIndicator: (target) => <DropLine target={target} />,
  });
  return (
    <section
      className={cn("flex min-h-0 w-72 shrink-0 flex-col rounded-xl bg-muted/50", className)}
    >
      <header className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        {icon}
        <h3 className="text-[13px] font-medium">{title}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">{count ?? issues.length}</span>
        <span className="ml-auto flex items-center gap-1">
          {aside}
          {onCreate && canWrite && (
            <Button variant="ghost" size="icon" aria-label={t("issue.new")} onPress={onCreate}>
              <Plus aria-hidden />
            </Button>
          )}
        </span>
      </header>
      <Virtualizer layout={ListLayout} layoutOptions={COLUMN_LAYOUT}>
        <ListBox
          aria-label={title}
          items={issues}
          selectionMode="none"
          dragAndDropHooks={dragAndDropHooks}
          className="min-h-16 flex-1 overflow-y-auto overscroll-contain rounded-b-xl outline-none transition-colors drop-target:bg-accent/60 drop-target:ring-2 drop-target:ring-primary/40"
          renderEmptyState={() => (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {emptyText ?? t("board.empty")}
            </p>
          )}
        >
          {(issue) => <BoardCard issue={issue} />}
        </ListBox>
      </Virtualizer>
      {footer}
    </section>
  );
}

function DropLine({ target }: { target: DropTarget }) {
  return (
    // The layout sizes the indicator's slot; only the active drop target is rendered.
    <DropIndicator target={target} className="z-10 h-full rounded-full bg-primary" />
  );
}

/** Column that accepts drops. Prefer this over `canDrop` so the mode is explicit at the call site. */
export function DroppableColumn(props: Omit<DndColumnProps, "canDrop">) {
  return <DndColumn {...props} canDrop />;
}

/** Column that never accepts drops (viewers, archived boards). */
export function ReadOnlyColumn(props: Omit<DndColumnProps, "canDrop">) {
  return <DndColumn {...props} canDrop={false} />;
}

export function BoardCard({ issue }: { issue: Issue }) {
  const { ws } = useWorkspace();
  const { t } = useI18n();
  return (
    <ListBoxItem
      id={issue.id}
      textValue={issue.title}
      href={`/${ws.id}/issue/${issue.id}`}
      className="group block cursor-default rounded-lg border border-border bg-card p-2.5 text-[13px] shadow-xs outline-none transition-[transform,opacity] hover:border-primary/40 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/60 dragging:opacity-40"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">{issueKey(issue.number)}</span>
        <BlockedBadge issue={issue} />
        <span className="ml-auto">
          <AssigneeAvatar issue={issue} size={18} />
        </span>
      </div>
      <p className="mt-1 line-clamp-3 font-medium leading-snug">{issue.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <PriorityIcon priority={issue.priority} />
        <LabelChips issue={issue} max={2} />
        <DeadlineChip issue={issue} />
        <SubtaskProgress issue={issue} />
        {issue.estimate ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {issue.estimate} {t("estimate.unit")}
          </span>
        ) : null}
      </div>
    </ListBoxItem>
  );
}
