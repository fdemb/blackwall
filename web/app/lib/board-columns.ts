import { useCallback, useState } from "react";
import { safeGet, safeSet } from "./storage";
import type { Id, Stage, StageKind } from "./types";

/** Board columns each person collapsed or expanded, per team. Unset stages follow their kind. */
const KEY = "bw-board-columns:v1";

/** Long columns start collapsed: the backlog and finished work. */
export const collapsedByDefault = (kind: StageKind) =>
  kind === "backlog" || kind === "done" || kind === "cancelled";

function read(key: string): Record<Id, boolean> {
  try {
    const value: unknown = JSON.parse(safeGet("local", key) ?? "{}");
    return value && typeof value === "object" ? (value as Record<Id, boolean>) : {};
  } catch {
    return {};
  }
}

/** Whether each of the team's board columns is collapsed, and a setter that remembers the choice. */
export function useCollapsedColumns(userId: Id, teamId: Id) {
  const key = `${KEY}:${userId}:${teamId}`;
  const [choices, setChoices] = useState(() => read(key));
  const isCollapsed = useCallback(
    (stage: Pick<Stage, "id" | "kind">) => choices[stage.id] ?? collapsedByDefault(stage.kind),
    [choices],
  );
  const setCollapsed = useCallback(
    (stageId: Id, collapsed: boolean) => {
      const next = { ...read(key), [stageId]: collapsed };
      safeSet("local", key, JSON.stringify(next));
      setChoices(next);
    },
    [key],
  );
  return { isCollapsed, setCollapsed };
}
