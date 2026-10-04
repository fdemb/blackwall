import { useNavigate, useSearchParams } from "react-router";
import {
  AtSign,
  Bell,
  CalendarClock,
  CheckCheck,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  MessageSquare,
  PenLine,
  UserPlus,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { issueKey, relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useIssues, useNotifications } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { AlertKind } from "~/lib/types";

const ICONS: Record<AlertKind, React.ComponentType<{ className?: string }>> = {
  assignment: UserPlus,
  reply: MessageSquare,
  change: PenLine,
  mention: AtSign,
  deadline: CalendarClock,
};

export default function Inbox() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const { ws, run, unread } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "unread" ? "unread" : "all";
  const setView = (v: "all" | "unread") =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === "all") next.delete("view");
        else next.set("view", v);
        return next;
      },
      { preventScrollReset: true },
    );
  const query = useNotifications();
  const unreadOnly = useNotifications(true);
  const sorted = query.items;
  const list = view === "unread" ? unreadOnly.items : sorted;
  const ids = sorted.flatMap((notification) =>
    notification.issue_id ? [notification.issue_id] : [],
  );
  const related = useIssues({ ids: [...new Set(ids)].join(",") }, ids.length > 0);
  const issues = new Map(related.items.map((issue) => [issue.id, issue]));
  return (
    <Page>
      <PageHeader
        title={t("nav.inbox")}
        icon={<InboxIcon className="size-4 text-muted-foreground" />}
        subtitle={unread ? t("inbox.unread", { n: unread }) : undefined}
        actions={
          unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => run({ type: "mark_all_notifications_read" }).catch(() => {})}
            >
              <CheckCheck />
              {t("inbox.markAll")}
            </Button>
          )
        }
        nav={
          sorted.length > 0 && (
            <Tabs
              selectedKey={view}
              onSelectionChange={(k) => {
                if (k === "all" || k === "unread") setView(k);
              }}
            >
              <TabList aria-label={t("nav.inbox")}>
                <Tab id="all" size="compact">
                  {t("inbox.all")}
                </Tab>
                <Tab id="unread" size="compact">
                  {t("inbox.unreadOnly")}
                  {unread > 0 && (
                    <span className="tabular-nums text-muted-foreground">{unread}</span>
                  )}
                </Tab>
              </TabList>
            </Tabs>
          )
        }
      />
      <Scroll>
        <QueryStatus query={query} />
        {sorted.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={t("inbox.emptyTitle")}
            description={t("inbox.emptySub")}
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={t("inbox.noUnread")}
            description={t("inbox.noUnreadSub")}
          />
        ) : (
          <ul className="[content-visibility:auto] [contain-intrinsic-size:auto_40rem]">
            {list.map((n) => {
              const Icon = ICONS[n.kind];
              const issue = n.issue_id ? issues.get(n.issue_id) : undefined;
              return (
                <li
                  key={n.id}
                  className="group flex items-center border-b border-border/70 hover:bg-muted/60 focus-within:bg-muted/60"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!n.read_at)
                        run({ type: "mark_notification_read", id: n.id }).catch(() => {});
                      if (n.issue_id) void nav(`/${ws.id}/issue/${n.issue_id}`);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-full",
                        n.read_at
                          ? "bg-muted text-muted-foreground"
                          : "bg-accent text-accent-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "line-clamp-2 block text-[13px]",
                          !n.read_at && "font-semibold",
                        )}
                      >
                        {n.message}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{t(`alert.${n.kind}`)}</span>
                        {issue && (
                          <span className="min-w-0 truncate">
                            <span className="tabular-nums">{issueKey(issue.number)}</span>{" "}
                            {issue.title}
                          </span>
                        )}
                        {issue?.deleted_at && <Badge tone="warning">{t("inbox.inTrash")}</Badge>}
                      </span>
                    </span>
                    <time
                      dateTime={n.created_at}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {relativeTime(n.created_at, lang)}
                    </time>
                    {!n.read_at && (
                      <span
                        role="img"
                        aria-label={t("inbox.unreadDot")}
                        className="size-2 shrink-0 rounded-full bg-primary"
                      />
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mr-2"
                    aria-label={n.read_at ? t("inbox.markUnread") : t("inbox.markRead")}
                    onPress={() =>
                      run(
                        n.read_at
                          ? { type: "mark_notification_unread", id: n.id }
                          : { type: "mark_notification_read", id: n.id },
                      ).catch(() => {})
                    }
                  >
                    {n.read_at ? <Mail /> : <MailOpen />}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>
    </Page>
  );
}
