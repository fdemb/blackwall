import { Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import {
  AtSign,
  Bell,
  CalendarClock,
  CheckCheck,
  Inbox as InboxIcon,
  ListTree,
  Mail,
  MailOpen,
  MessageSquare,
  PenLine,
  UserPlus,
} from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import {
  ALERT_KINDS,
  changedFieldLabels,
  groupByIssue,
  parseAlertKind,
  quotesComment,
} from "~/lib/inbox";
import { plainMentions } from "~/lib/mentions";
import { useIssueRef, useIssues, useNotifications } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { AlertKind, Id, Issue, Notification } from "~/lib/types";

const ICONS: Record<AlertKind, React.ComponentType<{ className?: string }>> = {
  assignment: UserPlus,
  reply: MessageSquare,
  change: PenLine,
  mention: AtSign,
  deadline: CalendarClock,
};

export default function Inbox() {
  const { t } = useI18n();
  const { issueKey = "" } = useParams();
  const issueId = useIssueRef(issueKey);
  const outletContext = useOutletContext();
  const { run, unread } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "unread" ? "unread" : "all";
  const kind = parseAlertKind(params.get("kind"));
  const grouped = params.get("group") === "issue";
  const setParam = (name: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { preventScrollReset: true },
    );
  const query = useNotifications();
  const unreadOnly = useNotifications(true);
  const sorted = query.items;
  // Keep the open item visible after selecting it marks it read.
  const visible =
    view === "unread"
      ? [
          ...unreadOnly.items,
          ...sorted.filter(
            (n) => n.issue_id === issueId && !unreadOnly.items.some((unread) => unread.id === n.id),
          ),
        ].sort((a, b) => b.created_at.localeCompare(a.created_at))
      : sorted;
  const list = kind ? visible.filter((n) => n.kind === kind) : visible;
  const ids = sorted.flatMap((notification) =>
    notification.issue_id ? [notification.issue_id] : [],
  );
  const related = useIssues({ ids: [...new Set(ids)].join(",") }, ids.length > 0);
  const issues = new Map(related.items.map((issue) => [issue.id, issue]));
  const kindOptions = [
    { id: "all", label: t("inbox.kindAll") },
    ...ALERT_KINDS.map((k) => ({ id: k, label: t(`alert.${k}`) })),
  ];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <Page
        className={cn(
          "min-w-0",
          issueId && "max-md:max-h-[35%] md:w-80 md:flex-none md:border-r md:border-border lg:w-96",
        )}
      >
        <PageHeader
          title={t("nav.inbox")}
          icon={<InboxIcon className="size-4 text-muted-foreground" />}
          actions={
            unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onPress={() =>
                  run({
                    type: "mark_all_notifications_read",
                    notifications: unreadOnly.items.map(({ id, created_at }) => ({
                      id,
                      created_at,
                    })),
                  }).catch(() => {})
                }
              >
                <CheckCheck />
                {t("inbox.markAll")}
              </Button>
            )
          }
          nav={
            sorted.length > 0 && (
              <>
                <Tabs
                  selectedKey={view}
                  onSelectionChange={(k) => {
                    if (k === "all") setParam("view", null);
                    if (k === "unread") setParam("view", k);
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
                <Select
                  aria-label={t("inbox.kind")}
                  variant="ghost"
                  options={kindOptions}
                  selectedKey={kind ?? "all"}
                  onSelectionChange={(k) => setParam("kind", k === "all" ? null : String(k))}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("inbox.groupByIssue")}
                  aria-pressed={grouped}
                  className={cn(grouped && "bg-muted text-foreground")}
                  onPress={() => setParam("group", grouped ? null : "issue")}
                >
                  <ListTree />
                </Button>
              </>
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
            kind && visible.length > 0 ? (
              <EmptyState
                icon={<Bell />}
                title={t("inbox.noMatch")}
                description={t("inbox.noMatchSub")}
              />
            ) : (
              <EmptyState
                icon={<Bell />}
                title={t("inbox.noUnread")}
                description={t("inbox.noUnreadSub")}
              />
            )
          ) : grouped ? (
            groupByIssue(list).map((group) => {
              const issue = group.issueId ? issues.get(group.issueId) : undefined;
              return (
                <section key={group.key} aria-label={issue?.key}>
                  {issue && <IssueHeading issue={issue} />}
                  <NotificationList
                    items={group.items}
                    issues={issues}
                    openIssue={issueId}
                    showIssue={!issue}
                  />
                </section>
              );
            })
          ) : (
            <NotificationList items={list} issues={issues} openIssue={issueId} showIssue />
          )}
        </Scroll>
      </Page>
      {issueId && (
        <div className="flex min-h-0 min-w-0 flex-1 border-t border-border md:border-t-0">
          <Outlet context={outletContext} />
        </div>
      )}
    </div>
  );
}

function IssueHeading({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  return (
    <h2 className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-4 py-1.5 text-muted-foreground">
      <span className="tabular-nums">{issue.key}</span>
      <span className="min-w-0 truncate text-foreground">{issue.title}</span>
      {issue.deleted_at && <Badge tone="warning">{t("inbox.inTrash")}</Badge>}
    </h2>
  );
}

function NotificationList({
  items,
  issues,
  openIssue,
  showIssue,
}: {
  items: readonly Notification[];
  issues: Map<Id, Issue>;
  openIssue: Id | undefined;
  showIssue: boolean;
}) {
  return (
    <ul className="[content-visibility:auto] [contain-intrinsic-size:auto_40rem]">
      {items.map((n) => (
        <NotificationRow
          key={n.id}
          notification={n}
          issue={showIssue && n.issue_id ? issues.get(n.issue_id) : undefined}
          active={Boolean(openIssue && n.issue_id === openIssue)}
        />
      ))}
    </ul>
  );
}

function useSummary() {
  const { t, lang } = useI18n();
  const { member } = useWorkspace();
  return (n: Notification): string | null => {
    if (!n.actor_id || n.kind === "deadline") return null;
    const actor = member(n.actor_id)?.display_name ?? t("person.unknown");
    if (n.kind !== "change") return t(`inbox.summary.${n.kind}`, { actor });
    const fields = changedFieldLabels(n).map((label) => t(label).toLocaleLowerCase(lang));
    return fields.length > 0
      ? t("inbox.summary.change", { actor, fields: fields.join(", ") })
      : t("inbox.summary.changeAny", { actor });
  };
}

function NotificationRow({
  notification: n,
  issue,
  active,
}: {
  notification: Notification;
  issue: Issue | undefined;
  active: boolean;
}) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { ws, run, issueRef } = useWorkspace();
  const summary = useSummary()(n);
  const quote = summary && quotesComment(n);
  const Icon = ICONS[n.kind];
  return (
    <li
      className={cn(
        "group flex items-center border-b border-border/70 hover:bg-muted/60 focus-within:bg-muted/60",
        active && "bg-accent text-accent-foreground hover:bg-accent focus-within:bg-accent",
      )}
    >
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => {
          if (!n.read_at)
            run({
              type: "mark_notification_read",
              id: n.id,
              created_at: n.created_at,
            }).catch(() => {});
          if (n.issue_id)
            void nav(`/${ws.slug}/inbox/issue/${issueRef(n.issue_id)}?${params}`, {
              preventScrollReset: true,
            });
        }}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full",
            n.read_at ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("line-clamp-2 block ", !n.read_at && "font-semibold")}>
            {summary ?? plainMentions(n.message)}
          </span>
          {quote && (
            <span className="line-clamp-2 block text-muted-foreground">
              {plainMentions(n.message)}
            </span>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2  text-muted-foreground">
            <span>{t(`alert.${n.kind}`)}</span>
            {issue && (
              <span className="min-w-0 truncate">
                <span className="tabular-nums">{issue.key}</span> {issue.title}
              </span>
            )}
            {issue?.deleted_at && <Badge tone="warning">{t("inbox.inTrash")}</Badge>}
          </span>
        </span>
        <time dateTime={n.created_at} className="shrink-0  text-muted-foreground">
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
              : {
                  type: "mark_notification_read",
                  id: n.id,
                  created_at: n.created_at,
                },
          ).catch(() => {})
        }
      >
        {n.read_at ? <Mail /> : <MailOpen />}
      </Button>
    </li>
  );
}
