import {
  CalendarDays,
  CalendarRange,
  CircleDot,
  Flag,
  FolderKanban,
  Gauge,
  GitFork,
  Lock,
  Pencil,
  Signal,
  Tag,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Key } from "~/lib/i18n";

export const ISSUE_FIELDS: Partial<Record<string, { label: Key; icon: LucideIcon }>> = {
  title: { label: "field.title", icon: Pencil },
  description: { label: "field.description", icon: Pencil },
  team: { label: "field.team", icon: Users },
  stage: { label: "field.stage", icon: CircleDot },
  assignee: { label: "field.assignee", icon: UserRound },
  priority: { label: "field.priority", icon: Signal },
  labels: { label: "field.labels", icon: Tag },
  estimate: { label: "field.estimate", icon: Gauge },
  deadline: { label: "field.deadline", icon: CalendarDays },
  project: { label: "field.project", icon: FolderKanban },
  milestone: { label: "field.milestone", icon: Flag },
  sprint: { label: "field.sprint", icon: CalendarRange },
  parent: { label: "issue.parent", icon: GitFork },
  dependencies: { label: "issue.dependencies", icon: Lock },
};
