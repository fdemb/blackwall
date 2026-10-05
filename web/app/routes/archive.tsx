import { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { expectedVersions } from "~/lib/entity-versions";
import { collectPages, workspaces } from "~/lib/api";
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
  // The server accepts at most 500 issues per bulk command, so a large archive is restored in batches.
  const unarchiveAll = async () => {
    setProgress({ done: 0, total: issues.length });
    try {
      const all = await collectPages((offset) =>
        workspaces.issues(ws.id, { archived: true }, offset),
      );
      const ids = all.map((issue) => issue.id);
      for (let at = 0; at < ids.length; at += 500) {
        await run(
          { type: "bulk_issues", ids: ids.slice(at, at + 500), action: "unarchive" },
          {
            expectedVersions: expectedVersions(
              ids.slice(at, at + 500),
              Object.fromEntries(all.map((issue) => [issue.id, issue.version])),
            ),
          },
        );
        setProgress({ done: Math.min(at + 500, ids.length), total: ids.length });
      }
      toast.show(t("archive.unarchivedN", { n: ids.length }));
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
        subtitle={t("archive.sub")}
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
                className="flex min-h-11 items-center gap-3 border-b border-border/70 px-4 py-1 text-[13px]"
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
                <span className="hidden text-xs text-muted-foreground sm:inline">
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
