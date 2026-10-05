import { Navigate, useParams, useSearchParams } from "react-router";
import { CircleUser, PenLine } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { EmptyState, PageCrumb } from "~/components/app/page";
import { useQueueState, Workbench } from "~/components/app/workbench";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { IssueFilter } from "~/lib/types";

type PersonTab = "assigned" | "created";

export default function Person() {
  const { t } = useI18n();
  const { userId, ws: wsId } = useParams();
  const { ws, member } = useWorkspace();
  // The tab lives in the URL so a link can open either list. Filters carry across tabs.
  const [params, setParams] = useSearchParams();
  const state = useQueueState();
  const m = member(userId);
  if (!m) return <Navigate to={`/${wsId}/people`} replace />;
  const tab: PersonTab = params.get("tab") === "created" ? "created" : "assigned";
  const role = ws.members.find((x) => x.user_id === m.id)?.role;
  const base: IssueFilter =
    tab === "created"
      ? { created_by: m.id }
      : // "Unassigned" from the other tab would otherwise empty this one.
        { assignee: m.id, unassigned: undefined };
  const heading = (
    <div className="mr-2 flex min-w-0 items-center gap-2 text-[13px]">
      <PageCrumb to={`/${ws.id}/people`}>{t("nav.people")}</PageCrumb>
      <span aria-hidden="true" className="text-muted-foreground/50">
        /
      </span>
      <Avatar name={m.display_name} src={m.avatar_url} size={20} />
      <h1 className="truncate font-medium">{m.display_name}</h1>
      <a
        href={`mailto:${m.email}`}
        className="hidden truncate text-muted-foreground hover:text-foreground hover:underline sm:block"
      >
        {m.email}
      </a>
      {role && <Badge tone={role === "owner" ? "primary" : "neutral"}>{t(`role.${role}`)}</Badge>}
    </div>
  );
  const tabs = (
    <Tabs
      selectedKey={tab}
      onSelectionChange={(k) =>
        setParams(k === "created" ? { tab: "created" } : {}, { preventScrollReset: true })
      }
    >
      <TabList aria-label={m.display_name}>
        <Tab id="assigned" size="compact">
          <CircleUser />
          {t("person.assigned")}
        </Tab>
        <Tab id="created" size="compact">
          <PenLine />
          {t("person.created")}
        </Tab>
      </TabList>
    </Tabs>
  );
  return (
    <Workbench
      state={state}
      title={m.display_name}
      heading={heading}
      nav={tabs}
      base={base}
      hide={tab === "assigned" ? ["assignee"] : []}
      empty={
        <EmptyState title={tab === "created" ? t("person.noCreated") : t("person.noAssigned")} />
      }
    />
  );
}
