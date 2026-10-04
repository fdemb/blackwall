import { Button } from "~/components/ui/button";
import { useT } from "~/lib/i18n";
import type { PaginationState } from "~/lib/queries";

export function QueryStatus({ query }: { query: PaginationState }) {
  const t = useT();
  if (query.error)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
        <span className="text-destructive">{query.error}</span>
        <Button size="sm" onPress={query.retry}>
          {t("action.retry")}
        </Button>
      </div>
    );
  if (query.loading)
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        {t("action.loading")}
      </p>
    );
  if (query.hasMore)
    return (
      <div className="px-4 py-3">
        <Button size="sm" onPress={query.loadMore}>
          {t("action.loadMore")}
        </Button>
      </div>
    );
  return null;
}
