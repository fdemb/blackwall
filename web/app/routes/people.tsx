import { useState } from "react";
import { Link } from "react-router";
import { Users } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { SearchField } from "~/components/ui/field";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

export default function People() {
  const t = useT();
  const { ws, members } = useWorkspace();
  const [q, setQ] = useState("");
  const list = members.filter((m) => `${m.display_name} ${m.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Page>
      <PageHeader title={t("nav.people")} icon={<Users className="size-4 text-muted-foreground" />} subtitle={t("count.members", { n: members.length })} actions={<SearchField aria-label={t("action.search")} placeholder={t("people.search")} value={q} onChange={setQ} className="w-56" />} />
      <Scroll>
        {list.length === 0 ? <EmptyState icon={<Users />} title={t("search.empty")} /> : (
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((m) => {
              const role = ws.members.find((x) => x.user_id === m.id)?.role;
              return (
                <li key={m.id}>
                  <Link to={`/${ws.id}/people/${m.id}`} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 shadow-xs outline-none transition hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/60">
                    <Avatar name={m.display_name} src={m.avatar_url} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{m.display_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    {role && <Badge tone={role === "owner" ? "primary" : "neutral"}>{t(`role.${role}`)}</Badge>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>
    </Page>
  );
}
