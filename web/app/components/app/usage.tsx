import { Badge } from "~/components/ui/badge";
import { ProgressBar } from "~/components/app/progress";
import { useI18n } from "~/lib/i18n";
import type { Usage } from "~/lib/types";

export type UsageLevel = "ok" | "near" | "full";

/** Near from 80% of the limit, which leaves room to act before writes fail. */
export function usageLevel({ used, limit }: Usage): UsageLevel {
  if (limit === null) return "ok";
  if (used >= limit) return "full";
  return used >= limit * 0.8 ? "near" : "ok";
}

export function UsageList({ usage }: { usage: Usage[] }) {
  const { t, lang } = useI18n();
  const number = new Intl.NumberFormat(lang);
  const pressed = usage.some((u) => usageLevel(u) !== "ok");
  return (
    <div className="divide-y divide-border/60">
      {pressed && (
        <p role="status" className="px-4 py-3 sm:px-5">
          {t("usage.notice")}
        </p>
      )}
      {usage.map((u) => {
        const level = usageLevel(u);
        const label = t(`usage.${u.resource}`);
        return (
          <div key={u.resource} className="space-y-1.5 px-4 py-3 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <span>{label}</span>
              <span className="flex items-center gap-2 text-muted-foreground tabular-nums">
                {level === "near" && <Badge tone="warning">{t("usage.near")}</Badge>}
                {level === "full" && <Badge tone="danger">{t("usage.full")}</Badge>}
                {u.limit === null
                  ? t("usage.unlimited", { used: number.format(u.used) })
                  : t("usage.of", { used: number.format(u.used), limit: number.format(u.limit) })}
              </span>
            </div>
            {u.limit !== null && (
              <ProgressBar value={Math.min(u.used, u.limit)} total={u.limit} label={label} />
            )}
          </div>
        );
      })}
    </div>
  );
}
