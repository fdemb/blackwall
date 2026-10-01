import { useState } from "react";
import { cn } from "~/lib/utils";

export function BarList({ rows, format }: { rows: { id: string; label: string; value: number; hint?: string }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[13px]">
          <span className="truncate">{r.label}</span>
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary/80 transition-[width] duration-500" style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <span className="w-20 text-right tabular-nums text-muted-foreground">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Columns({ data, label }: { data: { date: string; value: number }[]; label: (d: string, v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(data.length, 1);
  return (
    <div>
      <div className="relative h-36">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full overflow-visible" role="img" aria-label="Delivery">
          {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1="0" x2="100" y1={40 - f * 38} y2={40 - f * 38} stroke="currentColor" className="text-border" strokeWidth="0.2" vectorEffect="non-scaling-stroke" />)}
          {data.map((d, i) => {
            const h = (d.value / max) * 38;
            return (
              <rect key={d.date} x={i * w + w * 0.15} y={40 - h} width={w * 0.7} height={Math.max(h, d.value ? 0.6 : 0)} rx="0.6" className={cn("fill-primary transition-opacity", hover !== null && hover !== i && "opacity-40")} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            );
          })}
        </svg>
        {hover !== null && data[hover] && (
          <div className="pointer-events-none absolute -top-2 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow" style={{ left: `${Math.min(88, hover * w)}%` }}>{label(data[hover].date, data[hover].value)}</div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{data[0]?.date.slice(5)}</span><span>{data[data.length - 1]?.date.slice(5)}</span></div>
    </div>
  );
}
