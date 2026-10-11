import { useState } from "react";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

export function BarList({
  rows,
  format,
}: {
  rows: { id: string; label: string; value: number; hint?: string }[];
  format: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 ">
          <span className="truncate">{r.label}</span>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full w-full origin-left rounded-full bg-primary/80 transition-transform duration-500"
              style={{ transform: `scaleX(${r.value / max})` }}
            />
          </div>
          <span className="w-20 text-right tabular-nums text-muted-foreground">
            {format(r.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Column chart. Each column takes focus and responds to a tap, and a table below lists the same numbers,
 * so values are readable without a mouse.
 */
export function Columns({
  data,
  label,
  title,
}: {
  data: { date: string; value: number }[];
  label: (d: string, v: number) => string;
  title: string;
}) {
  const { t } = useI18n();
  // Both stay here: only this chart reads them, so a provider would add indirection without sharing.
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  return (
    <div>
      <ChartColumns data={data} label={label} title={title} active={active} onActive={setActive} />
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{data[0]?.date.slice(5)}</span>
        <span>{data[data.length - 1]?.date.slice(5)}</span>
      </div>
      <button
        type="button"
        aria-expanded={table}
        onClick={() => setTable(!table)}
        className="mt-2 rounded  text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {table ? t("reports.hideData") : t("reports.showData")}
      </button>
      {table && <ChartTable data={data} title={title} />}
    </div>
  );
}

/** The SVG columns. Composed by `Columns`; reads selection through props, not context. */
export function ChartColumns({
  data,
  label,
  title,
  active,
  onActive,
}: {
  data: { date: string; value: number }[];
  label: (d: string, v: number) => string;
  title: string;
  active: number | null;
  onActive: (i: number | null) => void;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(data.length, 1);
  const toggle = (i: number) => onActive(active === i ? null : i);
  return (
    <div className="relative h-36">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
        role="group"
        aria-label={title}
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1="0"
            x2="100"
            y1={40 - f * 38}
            y2={40 - f * 38}
            stroke="currentColor"
            className="text-border"
            strokeWidth="0.2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * 38;
          return (
            <g key={d.date}>
              {/* A wider invisible target makes thin columns easy to hit with a finger. */}
              <rect
                x={i * w}
                y="0"
                width={w}
                height="40"
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={label(d.date, d.value)}
                className="cursor-pointer outline-none focus-visible:stroke-primary focus-visible:stroke-2"
                onMouseEnter={() => onActive(i)}
                onMouseLeave={() => onActive(null)}
                onFocus={() => onActive(i)}
                onBlur={() => onActive(null)}
                onClick={() => toggle(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(i);
                  }
                }}
              />
              <rect
                x={i * w + w * 0.15}
                y={40 - h}
                width={w * 0.7}
                height={Math.max(h, d.value ? 0.6 : 0)}
                rx="0.6"
                className={cn(
                  "pointer-events-none fill-primary transition-opacity",
                  active !== null && active !== i && "opacity-40",
                )}
              />
            </g>
          );
        })}
      </svg>
      {active !== null && data[active] && (
        <div
          className="pointer-events-none absolute -top-2 rounded-md bg-foreground px-2 py-1  text-background shadow"
          style={{ left: `${Math.min(88, active * w)}%` }}
        >
          {label(data[active].date, data[active].value)}
        </div>
      )}
    </div>
  );
}

/** The data table behind the show/hide toggle. Same numbers as the chart, for screen readers. */
export function ChartTable({
  data,
  title,
}: {
  data: { date: string; value: number }[];
  title: string;
}) {
  const { t } = useI18n();
  return (
    <table className="mt-2 w-full ">
      <thead>
        <tr className="border-b border-border text-left text-muted-foreground">
          <th className="py-1 font-medium">{t("field.date")}</th>
          <th className="py-1 text-right font-medium">{title}</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.date} className="border-b border-border/60 last:border-0">
            <td className="py-1 tabular-nums">{d.date}</td>
            <td className="py-1 text-right tabular-nums">{d.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
