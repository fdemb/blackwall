import { useNavigate } from "react-router";
import {
  AtSign,
  Bell,
  CalendarClock,
  CheckCheck,
  Inbox as InboxIcon,
  MessageSquare,
  PenLine,
  UserPlus,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
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
  const list = [...ws.notifications].sort(
    (a, b) => +new Date(b.created_at) - +new Date(a.created_at),
  );
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
      />
      <Scroll>
        {list.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={t("inbox.emptyTitle")}
            description={t("inbox.emptySub")}
          />
        ) : (
          <ul>
            {list.map((n) => {
              const Icon = ICONS[n.kind];
              return (
                <li key={n.id} className="border-b border-border/70">
                  <button
                    type="button"
                    onClick={() => {
                      if (!n.read_at)
                        run({ type: "mark_notification_read", id: n.id }).catch(() => {});
                      if (n.issue_id) nav(`/${ws.id}/issue/${n.issue_id}`);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
                  >
                    <span
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
                        className={cn("block truncate text-[13px]", !n.read_at && "font-semibold")}
                      >
                        {n.message}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`alert.${n.kind}`)}
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
                        aria-label={t("inbox.unreadDot")}
                        className="size-2 shrink-0 rounded-full bg-primary"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>
    </Page>
  );
}
