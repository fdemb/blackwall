import { useSearchParams } from "react-router";
import { UserRound } from "lucide-react";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { Workbench } from "~/components/app/workbench";
import { EmptyState } from "~/components/app/page";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { CheckCheck } from "lucide-react";

export default function MyIssues() {
  const { t } = useI18n();
  const { me } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "following" ? "following" : "assigned";
  const setTab = (v: "assigned" | "following") =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === "assigned") next.delete("tab");
        else next.set("tab", v);
        return next;
      },
      { preventScrollReset: true },
    );
  return (
    <Workbench
      title={t("nav.myIssues")}
      icon={<UserRound className="size-4 text-muted-foreground" />}
      base={tab === "assigned" ? { assignee: me } : {}}
      extraFilter={tab === "following" ? (i) => i.followers.includes(me) : undefined}
      hide={tab === "assigned" ? ["assignee"] : []}
      saveable={tab === "assigned"}
      nav={
        <Tabs
          selectedKey={tab}
          onSelectionChange={(k) => {
            if (k === "assigned" || k === "following") setTab(k);
          }}
        >
          <TabList aria-label={t("nav.myIssues")}>
            <Tab id="assigned" size="compact">
              {t("my.assigned")}
            </Tab>
            <Tab id="following" size="compact">
              {t("my.following")}
            </Tab>
          </TabList>
        </Tabs>
      }
      empty={
        <EmptyState
          icon={<CheckCheck />}
          title={tab === "assigned" ? t("my.emptyTitle") : t("my.followEmptyTitle")}
          description={tab === "assigned" ? t("my.emptySub") : t("my.followEmptySub")}
        />
      }
    />
  );
}
