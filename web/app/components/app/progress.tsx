import { cn } from "~/lib/utils";

export function ProgressBar({
  value,
  total,
  className,
  label,
}: {
  value: number;
  total: number;
  className?: string;
  label?: string;
}) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 overflow-hidden rounded-full bg-border", className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
