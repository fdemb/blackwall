import { WifiOff } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

export function OfflineBanner() {
  const { t } = useI18n();
  const { offline, retrySync } = useWorkspace();
  if (!offline) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/15 px-4 py-1.5 text-xs"
    >
      <WifiOff className="size-3.5 shrink-0" />
      <span className="flex-1">{t("error.offline")}</span>
      <Button size="sm" variant="ghost" onPress={retrySync}>
        {t("error.offlineRetry")}
      </Button>
    </div>
  );
}
