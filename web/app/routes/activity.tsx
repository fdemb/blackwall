import { History } from "lucide-react";
import { Link } from "react-router";
import { Avatar } from "~/components/ui/avatar";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { activityLabel } from "./issue";

export default function ActivityPage() {
  const { t, lang } = useI18n();
  const { ws, member } = useWorkspace();
  const items = [...ws.activity].reverse().slice(0, 200);
  return (
    <Page>
      <PageHeader title={t("activity.title")} icon={<History className="size-4 text-muted-foreground" />} />
      <Scroll>
        {items.length === 0 ? <EmptyState icon={<History />} title={t("activity.empty")} /> : (
          <ul className="mx-auto max-w-3xl p-4">
            {items.map((a) => {
              const m = member(a.actor);
              const issue = ws.issues.find((i) => i.id === a.entity_id);
              return (
                <li key={a.id} className="flex items-center gap-3 border-b border-border/60 py-2.5 text-[13px]">
                  <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={20} />
                  <span className="min-w-0 flex-1 truncate"><span className="font-medium">{m?.display_name ?? t("person.unknown")}</span> <span className="text-muted-foreground">{activityLabel(t, a.action)}</span>{issue && <> <Link to={`/${ws.id}/issue/${issue.id}`} className="hover:underline">{issue.title}</Link></>}</span>
                  <time dateTime={a.at} className="shrink-0 text-xs text-muted-foreground">{relativeTime(a.at, lang)}</time>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>
    </Page>
  );
}
