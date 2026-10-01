import { ListBox, ListBoxItem, useDragAndDrop, type DropTarget } from "react-aria-components";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { issueKey } from "~/lib/format";
import { useT } from "~/lib/i18n";
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
}: {
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
}) {
  const t = useT();
  const { canWrite } = useWorkspace();
  const beforeFor = (target: DropTarget): Id | null => {
    if (target.type !== "item") return null;
    const index = issues.findIndex((i) => i.id === target.key);
    if (index < 0) return null;
    return target.dropPosition === "before" ? issues[index].id : (issues[index + 1]?.id ?? null);
  };
  const read = async (items: { kind: string; getText?: (t: string) => Promise<string> }[]) => {
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
  };
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
              <Plus />
            </Button>
          )}
        </span>
      </header>
      <ListBox
        aria-label={title}
        items={issues}
        selectionMode="none"
        dragAndDropHooks={dragAndDropHooks}
        className="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5 outline-none drop-target:bg-accent/60 drop-target:ring-2 drop-target:ring-primary/40 rounded-b-xl transition-colors"
        renderEmptyState={() => (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {emptyText ?? t("board.empty")}
          </p>
        )}
      >
        {(issue) => <BoardCard issue={issue} />}
      </ListBox>
      {footer}
    </section>
  );
}

import { DropIndicator } from "react-aria-components";
function DropLine({ target }: { target: DropTarget }) {
  return (
    <DropIndicator
      target={target}
      className="relative z-10 h-0.5 rounded-full bg-primary dragging:opacity-0 drop-target:h-1 -my-0.5 [&[data-drop-target]]:bg-primary"
    />
  );
}

export function BoardCard({ issue }: { issue: Issue }) {
  const { ws } = useWorkspace();
  return (
    <ListBoxItem
      id={issue.id}
      textValue={issue.title}
      href={`/${ws.id}/issue/${issue.id}`}
      className="group cursor-default rounded-lg border border-border bg-card p-2.5 text-[13px] shadow-xs outline-none transition-[box-shadow,border-color,opacity] hover:border-primary/40 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/60 dragging:opacity-40"
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
          <span className="text-xs tabular-nums text-muted-foreground">{issue.estimate} pt</span>
        ) : null}
      </div>
    </ListBoxItem>
  );
}
