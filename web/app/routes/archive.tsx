import { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { issueCapabilities } from "~/lib/ownership";
import { bulkIssueCommands } from "~/lib/bulk-issues";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { issueKey, relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { useToast } from "~/components/ui/toast";

export default function ArchivePage() {
  const { t, lang } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  const toast = useToast();
  const query = useIssues({ archived: true, sort: "updated" });
  const issues = query.items;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const unarchiveAll = async () => {
    // Snapshot: built before the first await, so later view changes do not affect this run.
    const commands = bulkIssueCommands(
      issues,
      "unarchive",
      (issue) => issueCapabilities(issue).edit,
    );
    const total = commands.reduce((sum, command) => sum + command.ids.length, 0);
    setProgress({ done: 0, total });
    try {
      let done = 0;
      for (const command of commands) {
        await run(command);
        done += command.ids.length;
        setProgress({ done, total });
      }
      toast.show(t("archive.unarchivedN", { count: total }));
    } catch {
      /* the failed batch already showed its error; the rest stay archived */
    }
    setProgress(null);
  };
  return (
    <Page>
      <PageHeader
        title={t("nav.archive")}
        icon={<Archive className="size-4 text-muted-foreground" />}
        actions={
          canWrite &&
          issues.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              isDisabled={progress !== null}
              onPress={() => void unarchiveAll()}
            >
              <ArchiveRestore />
              {progress ? t("archive.unarchiving", progress) : t("archive.unarchiveAll")}
            </Button>
          )
        }
      />
      <Scroll>
        <QueryStatus query={query} />
        {query.loading || query.error ? null : issues.length === 0 ? (
          <EmptyState
            icon={<Archive />}
            title={t("archive.emptyTitle")}
            description={t("archive.emptySub")}
          />
        ) : (
          <ul>
            {issues.map((i) => (
              <li
                key={i.id}
                className="flex min-h-11 items-center gap-3 border-b border-border/70 px-4 py-1 "
              >
                <span className="w-14 tabular-nums text-muted-foreground">
                  {issueKey(i.number)}
                </span>
                <Link
                  to={`/${ws.id}/issue/${i.id}`}
                  className="min-w-0 flex-1 truncate hover:text-foreground"
                >
                  {i.title}
                </Link>
                <span className="hidden  text-muted-foreground sm:inline">
                  {i.archived_at &&
                    t("archive.archived", { when: relativeTime(i.archived_at, lang) })}
                </span>
                {canWrite && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() =>
                      run({ type: "unarchive_issue", id: i.id })
                        .then(() => toast.show(t("archive.unarchived")))
                        .catch(() => {})
                    }
                  >
                    <ArchiveRestore />
                    {t("action.unarchive")}
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
