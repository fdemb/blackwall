import { Link, Navigate, useParams } from "react-router";
import { ChevronLeft, Mail, Phone } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { IssueList } from "~/components/app/issue-list";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useIssues } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";

const PHONE_LIKE = /^[+\d][\d\s()-]{5,}$/;
const WHITESPACE = /\s/g;

export default function Person() {
  const t = useT();
  const { userId, ws: wsId } = useParams();
  const { ws, member } = useWorkspace();
  const query = useIssues({ assignee: userId, open: true });
  const m = member(userId);
  if (!m) return <Navigate to={`/${wsId}/people`} replace />;
  const role = ws.members.find((x) => x.user_id === m.id)?.role;
  const issues = query.items;
  const teams = ws.teams.filter((x) => x.members.includes(m.id));
  const looksLikePhone = PHONE_LIKE.test(m.contact);
  return (
    <Page>
      <PageHeader
        title={m.display_name}
        icon={
          <Link
            to={`/${ws.id}/people`}
            aria-label={t("action.back")}
            className="-ml-1 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Link>
        }
      />
      <Scroll>
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Avatar name={m.display_name} src={m.avatar_url} size={72} />
            <div className="min-w-0 flex-1 basis-60 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="min-w-0 break-words text-xl font-semibold tracking-tight">
                  {m.display_name}
                </h2>
                {role && (
                  <Badge tone={role === "owner" ? "primary" : "neutral"}>{t(`role.${role}`)}</Badge>
                )}
              </div>
              <a
                href={`mailto:${m.email}`}
                className="flex items-start gap-2 break-all text-[13px] text-muted-foreground hover:text-foreground"
              >
                <Mail className="mt-0.5 size-3.5 shrink-0" />
                {m.email}
              </a>
              {m.contact &&
                (looksLikePhone ? (
                  <a
                    href={`tel:${m.contact.replace(WHITESPACE, "")}`}
                    className="flex items-start gap-2 break-words text-[13px] text-muted-foreground hover:text-foreground"
                  >
                    <Phone className="mt-0.5 size-3.5 shrink-0" />
                    {m.contact}
                  </a>
                ) : (
                  <p className="flex items-start gap-2 whitespace-pre-line break-words text-[13px] text-muted-foreground">
                    <Phone className="mt-0.5 size-3.5 shrink-0" />
                    {m.contact}
                  </p>
                ))}
            </div>
          </div>
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">{t("nav.teams")}</h3>
            {teams.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t("person.noTeams")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {teams.map((x) => (
                  <Link
                    key={x.id}
                    to={`/${ws.id}/team/${x.id}`}
                    className="rounded-full border border-border px-3 py-1 text-[13px] hover:border-primary/50 hover:text-primary"
                  >
                    {x.name}
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-semibold">{t("person.assigned")}</h3>
            <div className="overflow-hidden rounded-xl border border-border">
              <IssueList
                issues={issues}
                groupBy="none"
                selectable={false}
                emptyState={<EmptyState title={t("person.noIssues")} />}
              />
            </div>
            <QueryStatus query={query} />
          </section>
        </div>
      </Scroll>
    </Page>
  );
}
