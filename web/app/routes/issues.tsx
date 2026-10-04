import { Layers } from "lucide-react";
import { Workbench } from "~/components/app/workbench";
import { useI18n } from "~/lib/i18n";

export default function AllIssues() {
  const { t } = useI18n();
  return (
    <Workbench
      title={t("nav.allIssues")}
      icon={<Layers className="size-4 text-muted-foreground" />}
    />
  );
}
