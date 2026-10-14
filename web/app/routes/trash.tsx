import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { bulkIssueCommands } from "~/lib/bulk-issues";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { relativeTime } from "~/lib/format";
import { IssueKey, useIssueKeyWidth } from "~/components/app/issue-key";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { useToast } from "~/components/ui/toast";

export default function Trash() {
  const { t, lang } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  const toast = useToast();
  const query = useIssues({ trash: true, sort: "updated" });
  const issues = query.items;
  const keyWidth = useIssueKeyWidth(issues);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const restoreAll = async () => {
    // Snapshot: built before the first await, so later view changes do not affect this run.
    const commands = bulkIssueCommands(issues, "restore");
    const total = commands.reduce((sum, command) => sum + command.ids.length, 0);
    setProgress({ done: 0, total });
    try {
      let done = 0;
      for (const command of commands) {
        await run(command);
        done += command.ids.length;
        setProgress({ done, total });
      }
      toast.show(t("trash.restoredN", { count: total }));
    } catch {
      /* the failed batch already showed its error; the rest stay in Trash */
    }
    setProgress(null);
  };
  return (
    <Page>
      <PageHeader
        title={t("nav.trash")}
        icon={<Trash2 className="size-4 text-muted-foreground" />}
        actions={
          canWrite &&
          issues.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={progress !== null}
              onPress={() => void restoreAll()}
            >
              <RotateCcw />
              {progress ? t("trash.restoring", progress) : t("trash.restoreAll")}
            </Button>
          )
        }
      />
      <Scroll>
        <QueryStatus query={query} />
        {query.loading || query.error ? null : issues.length === 0 ? (
          <EmptyState
            icon={<Trash2 />}
            title={t("trash.emptyTitle")}
            description={t("trash.emptySub")}
          />
        ) : (
          <ul>
            {issues.map((i) => (
              <li
                key={i.id}
                className="flex min-h-11 items-center gap-3 border-b border-border/70 px-4 py-1 "
              >
                <IssueKey value={i.key} width={keyWidth} className="text-muted-foreground" />
                <Link
                  to={`/${ws.slug}/issue/${i.ref}`}
                  className="min-w-0 flex-1 truncate text-muted-foreground line-through hover:text-foreground"
                >
                  {i.title}
                </Link>
                <span className="hidden  text-muted-foreground sm:inline">
                  {i.deleted_at && t("trash.deleted", { when: relativeTime(i.deleted_at, lang) })}
                </span>
                {canWrite && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() =>
                      run({ type: "restore_issue", id: i.id })
                        .then(() => toast.show(t("trash.restored")))
                        .catch(() => {})
                    }
                  >
                    <RotateCcw />
                    {t("action.restore")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Scroll>
    </Page>
  );
}
