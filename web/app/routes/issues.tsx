import { useSearchParams } from "react-router";
import { Layers } from "lucide-react";
import { Workbench } from "~/components/app/workbench";
import { whereIs } from "~/lib/filters";
import { useI18n } from "~/lib/i18n";

export default function AllIssues() {
  const { t } = useI18n();
  // Label chips on cards link here with `?label=<id>` to start filtered by that label.
  const [params] = useSearchParams();
  const label = params.get("label");
  return (
    <Workbench
      key={label}
      title={t("nav.allIssues")}
      icon={<Layers className="size-4 text-muted-foreground" />}
      initial={label ? { where: [whereIs("labels", label)] } : undefined}
    />
  );
}
