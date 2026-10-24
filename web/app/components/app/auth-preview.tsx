import { useState } from "react";
import { CircleDot, FolderKanban, Inbox } from "lucide-react";
import { PriorityIcon, StageIcon } from "~/components/app/icons";
import { Avatar } from "~/components/ui/avatar";
import { useI18n, type Key } from "~/lib/i18n";
import type { Priority, StageKind } from "~/lib/types";
import { cn } from "~/lib/utils";

interface SampleIssue {
  key: string;
  title: Key;
  priority: Priority;
  tag: string;
  due?: boolean;
  assignee: string;
}

const GROUPS: { kind: StageKind; issues: SampleIssue[] }[] = [
  {
    kind: "active",
    issues: [
      {
        key: "ENG-142",
        title: "auth.preview.issue1",
        priority: "high",
        tag: "Sprint 18",
        assignee: "Filip Nowak",
      },
      {
        key: "ENG-139",
        title: "auth.preview.issue2",
        priority: "normal",
        tag: "Sprint 18",
        assignee: "Filip Nowak",
      },
      {
        key: "DES-87",
        title: "auth.preview.issue3",
        priority: "normal",
        tag: "Onboarding",
        assignee: "Anna Kowalska",
      },
    ],
  },
  {
    kind: "planned",
    issues: [
      {
        key: "ENG-151",
        title: "auth.preview.issue4",
        priority: "urgent",
        tag: "",
        due: true,
        assignee: "Filip Nowak",
      },
      {
        key: "ENG-147",
        title: "auth.preview.issue5",
        priority: "low",
        tag: "Sprint 19",
        assignee: "Anna Kowalska",
      },
    ],
  },
];

/** A static picture of the issue list for the sign-in pages. Decorative, so it never takes focus. */
export function AuthPreview() {
  const { t, lang } = useI18n();
  const [soon] = useState(() => Date.now() + 3 * 86_400_000);
  const due = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(soon);
  return (
    <div className="relative flex max-h-[560px] min-h-0 flex-1 select-none overflow-hidden rounded-tl-xl border-l border-t border-primary/20 bg-background shadow-[0_24px_60px_-12px] shadow-primary/25 dark:shadow-black/60">
      <div className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2.5 py-3.5">
        <div className="flex items-center gap-2 px-2 pb-3.5 pt-1 font-semibold">
          <span className="size-[18px] rounded-[5px] bg-primary" />
          Acme
        </div>
        <NavItem icon={<Inbox />} label={t("nav.inbox")} count={4} />
        <NavItem icon={<CircleDot />} label={t("nav.myIssues")} active />
        <NavItem icon={<FolderKanban />} label={t("nav.projects")} />
        <div className="px-2 pb-1.5 pt-4 text-xs font-medium text-muted-foreground">
          {t("nav.teams")}
        </div>
        <NavItem icon={<span className="size-3.5 rounded bg-warning" />} label="Engineering" />
        <NavItem icon={<span className="size-3.5 rounded bg-success" />} label="Design" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5 font-medium">
          {t("nav.myIssues")}
        </div>
        {GROUPS.map((group) => (
          <div key={group.kind}>
            <div className="flex h-8 items-center gap-2 bg-sidebar px-5 text-sm font-medium">
              <StageIcon kind={group.kind} />
              {t(`stage.kind.${group.kind}`)}
              <span className="font-normal tabular-nums text-muted-foreground">
                {group.issues.length}
              </span>
            </div>
            {group.issues.map((issue) => (
              <div
                key={issue.key}
                className="flex h-10 items-center gap-3 border-b border-border/60 px-5"
              >
                <PriorityIcon priority={issue.priority} className="text-muted-foreground" />
                <span className="w-14 shrink-0 font-mono text-sm text-muted-foreground">
                  {issue.key}
                </span>
                <StageIcon kind={group.kind} />
                <span className="min-w-0 flex-1 truncate">{t(issue.title)}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 text-xs leading-[18px]",
                    issue.due
                      ? "border-destructive/30 text-destructive"
                      : "border-border text-secondary-foreground",
                  )}
                >
                  {issue.due ? due : issue.tag}
                </span>
                <Avatar name={issue.assignee} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  count,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 text-secondary-foreground [&_svg]:size-3.5",
        active && "bg-secondary font-medium text-foreground",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </div>
  );
}
