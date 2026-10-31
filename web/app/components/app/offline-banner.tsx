import { AlertTriangle, WifiOff, type LucideIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useI18n, type Key } from "~/lib/i18n";
import { useWorkspace, type SyncProblem } from "~/lib/workspace";

const VIEW: Record<Exclude<SyncProblem, null>, { icon: LucideIcon; message: Key }> = {
  offline: { icon: WifiOff, message: "error.offline" },
  unreachable: { icon: WifiOff, message: "error.offline" },
  stalled: { icon: AlertTriangle, message: "error.syncStalled" },
  blocked: { icon: AlertTriangle, message: "error.syncBlocked" },
  storage: { icon: AlertTriangle, message: "error.storageFull" },
  error: { icon: AlertTriangle, message: "error.syncFailed" },
};

export function OfflineBanner() {
  const { t } = useI18n();
  const { syncProblem, syncError, retrySync } = useWorkspace();
  if (!syncProblem) return null;
  const { icon: Icon, message } = VIEW[syncProblem];
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/15 px-4 py-1.5 "
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="flex-1">
        {t(message, { message: syncError?.message ?? t("error.unknown") })}
      </span>
      <Button size="sm" variant="ghost" onPress={retrySync}>
        {t("error.offlineRetry")}
      </Button>
    </div>
  );
}
