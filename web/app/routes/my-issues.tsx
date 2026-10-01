import { useState } from "react";
import { UserRound } from "lucide-react";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { Workbench } from "~/components/app/workbench";
import { EmptyState } from "~/components/app/page";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { CheckCheck } from "lucide-react";

export default function MyIssues() {
  const t = useT();
  const { me } = useWorkspace();
  const [tab, setTab] = useState<"assigned" | "following">("assigned");
  return (
    <Workbench
      key={tab}
      title={t("nav.myIssues")}
      icon={<UserRound className="size-4 text-muted-foreground" />}
      base={tab === "assigned" ? { assignee: me } : {}}
      extraFilter={tab === "following" ? (i) => i.followers.includes(me) : undefined}
      hide={tab === "assigned" ? ["assignee"] : []}
      saveable={tab === "assigned"}
      headerExtra={
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as never)} className="px-4 pb-2">
          <TabList aria-label={t("nav.myIssues")}>
            <Tab id="assigned">{t("my.assigned")}</Tab>
            <Tab id="following">{t("my.following")}</Tab>
          </TabList>
        </Tabs>
      }
      empty={<EmptyState icon={<CheckCheck />} title={tab === "assigned" ? t("my.emptyTitle") : t("my.followEmptyTitle")} description={tab === "assigned" ? t("my.emptySub") : t("my.followEmptySub")} />}
    />
  );
}
