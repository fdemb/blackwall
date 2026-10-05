import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Users } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SearchField } from "~/components/ui/field";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { useI18n } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { useWorkspace } from "~/lib/workspace";
import type { Id } from "~/lib/types";

export default function People() {
  const { t, lang } = useI18n();
  const { ws, members } = useWorkspace();
  const [q, setQ] = useState("");
  const open = useIssues({ open: true });
  const openCount = useMemo(() => {
    const counts = new Map<Id, number>();
    for (const i of open.items)
      if (i.assignee) counts.set(i.assignee, (counts.get(i.assignee) ?? 0) + 1);
    return counts;
  }, [open.items]);
  const needle = q.trim().toLowerCase();
  const list = members
    .filter((m) => `${m.display_name} ${m.email}`.toLowerCase().includes(needle))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, lang));
  return (
    <Page>
      <PageHeader
        title={t("nav.people")}
        icon={<Users className="size-4 text-muted-foreground" />}
        subtitle={t("count.members", { count: members.length })}
      >
        <div className="px-4 pb-2">
          <SearchField
            aria-label={t("action.search")}
            placeholder={t("people.search")}
            value={q}
            onChange={setQ}
            className="w-full sm:w-64"
            inputClassName="h-7 pointer-coarse:h-9"
          />
        </div>
      </PageHeader>
      <Scroll>
        {list.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={t("search.empty")}
            description={t("people.noMatch", { q: q.trim() })}
            action={<Button onPress={() => setQ("")}>{t("action.clearSearch")}</Button>}
          />
        ) : (
          <>
            <div
              aria-hidden
              className="flex h-8 items-center gap-3 border-b border-border px-4 text-xs text-muted-foreground"
            >
              <span className="flex-1 pl-10">{t("field.name")}</span>
              <span className="hidden w-48 md:block">{t("nav.teams")}</span>
              <span className="hidden w-24 text-right sm:block">{t("people.openIssues")}</span>
              <span className="w-20 text-right">{t("field.role")}</span>
            </div>
            <ul className="divide-y divide-border">
              {list.map((m) => {
                const role = ws.members.find((x) => x.user_id === m.id)?.role;
                const teams = ws.teams.filter((x) => x.members.includes(m.id)).map((x) => x.name);
                const count = openCount.get(m.id) ?? 0;
                return (
                  <li key={m.id}>
                    <Link
                      to={`/${ws.id}/people/${m.id}`}
                      className="flex min-h-12 items-center gap-3 px-4 py-2 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                    >
                      <Avatar name={m.display_name} src={m.avatar_url} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{m.display_name}</p>
                        <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      <span className="hidden w-48 truncate text-[13px] text-muted-foreground md:block">
                        {teams.join(", ") || "–"}
                      </span>
                      <span className="hidden w-24 text-right text-[13px] tabular-nums text-muted-foreground sm:block">
                        {count}
                      </span>
                      <span className="flex w-20 justify-end">
                        {role && (
                          <Badge tone={role === "owner" ? "primary" : "neutral"}>
                            {t(`role.${role}`)}
                          </Badge>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Scroll>
    </Page>
  );
}
