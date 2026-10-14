import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FormError } from "~/components/ui/field";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import { trackerApi, trackerKey, trackerProviderName } from "~/lib/trackers";
import type { TrackerConnection } from "~/lib/types";

/**
 * Where discovery stands for a step that lists cached remote data. `empty` is the step's own
 * "nothing cached" message, shown once discovery is no longer running.
 */
export function Discovery({
  connection,
  hasItems,
  empty,
}: {
  connection: TrackerConnection | null;
  hasItems: boolean;
  empty: string;
}) {
  const { ws } = useWorkspace();
  const { t } = useI18n();
  const client = useQueryClient();
  const { pending, error, guard } = usePending();
  if (!connection) return null;
  const provider = trackerProviderName(connection.provider);
  const running = connection.status === "pending" || connection.status === "syncing";
  const refresh = () =>
    void guard(async () => {
      await trackerApi.refresh(ws.id, connection.id);
      await client.invalidateQueries({ queryKey: trackerKey(ws.id) });
    });
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <p role="status" className="flex flex-1 items-center gap-1.5">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {t("tracker.discovering", { provider })}
          </p>
        ) : (
          <p className="flex-1">{hasItems ? t("tracker.discovered", { provider }) : empty}</p>
        )}
        <Button
          size="sm"
          variant="ghost"
          isDisabled={pending || running || !connection.enabled}
          onPress={refresh}
        >
          <RefreshCw />
          {t("tracker.refresh")}
        </Button>
      </div>
      {connection.status === "error" && connection.last_error ? (
        <p role="alert" className="break-words text-destructive">
          {t("tracker.error")}: {connection.last_error}
        </p>
      ) : null}
      <FormError>{error}</FormError>
    </div>
  );
}
