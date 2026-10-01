import { RotateCcw, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { applyFilter } from "~/lib/filters";
import { issueKey, relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { useToast } from "~/components/ui/toast";

export default function Trash() {
  const { t, lang } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  const toast = useToast();
  const issues = applyFilter(ws, { trash: true, sort: "updated" });
  return (
    <Page>
      <PageHeader
        title={t("nav.trash")}
        icon={<Trash2 className="size-4 text-muted-foreground" />}
        subtitle={t("trash.sub")}
        actions={
          canWrite &&
          issues.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onPress={() =>
                run({ type: "bulk_issues", ids: issues.map((i) => i.id), action: "restore" })
                  .then(() => toast.show(t("trash.restored")))
                  .catch(() => {})
              }
            >
              <RotateCcw />
              {t("trash.restoreAll")}
            </Button>
          )
        }
      />
      <Scroll>
        {issues.length === 0 ? (
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
                className="flex h-11 items-center gap-3 border-b border-border/70 px-4 text-[13px]"
              >
                <span className="w-14 tabular-nums text-muted-foreground">
                  {issueKey(i.number)}
                </span>
                <Link
                  to={`/${ws.id}/issue/${i.id}`}
                  className="min-w-0 flex-1 truncate text-muted-foreground line-through hover:text-foreground"
                >
                  {i.title}
                </Link>
                <span className="text-xs text-muted-foreground">
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
