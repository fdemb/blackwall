import { cn } from "~/lib/utils";
import type { Priority, StageKind } from "~/lib/types";

export function StageIcon({
  kind,
  className,
  progress,
}: {
  kind: StageKind;
  className?: string;
  progress?: number;
}) {
  const c = cn("size-3.5 shrink-0", className);
  switch (kind) {
    case "backlog":
      return (
        <svg viewBox="0 0 14 14" className={c} fill="none" aria-hidden>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="2.2 2.2"
            className="text-muted-foreground"
          />
        </svg>
      );
    case "planned":
      return (
        <svg viewBox="0 0 14 14" className={c} fill="none" aria-hidden>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-muted-foreground"
          />
        </svg>
      );
    case "active": {
      const p = progress ?? 0.5;
      const a = p * Math.PI * 2 - Math.PI / 2;
      const x = 7 + 3 * Math.cos(a);
      const y = 7 + 3 * Math.sin(a);
      return (
        <svg viewBox="0 0 14 14" className={c} fill="none" aria-hidden>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-warning"
          />
          <path
            d={`M7 4 A3 3 0 ${p > 0.5 ? 1 : 0} 1 ${x} ${y} L7 7 Z`}
            fill="currentColor"
            className="text-warning"
          />
        </svg>
      );
    }
    case "done":
      return (
        <svg viewBox="0 0 14 14" className={c} aria-hidden>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" className="text-primary" />
          <path
            d="M4.3 7.2l1.9 1.9 3.5-3.7"
            stroke="white"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "cancelled":
      return (
        <svg viewBox="0 0 14 14" className={c} aria-hidden>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" className="text-muted-foreground/60" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
  }
}

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const c = cn("size-3.5 shrink-0", className);
  if (priority === "urgent")
    return (
      <svg viewBox="0 0 14 14" className={c} aria-hidden>
        <rect
          x="1.5"
          y="1.5"
          width="11"
          height="11"
          rx="3"
          fill="currentColor"
          className="text-destructive"
        />
        <rect x="6.3" y="3.6" width="1.4" height="4.2" rx=".7" fill="white" />
        <circle cx="7" cy="9.8" r=".85" fill="white" />
      </svg>
    );
  const level = { none: 0, low: 1, normal: 2, high: 3 }[priority];
  if (priority === "none")
    return (
      <svg viewBox="0 0 14 14" className={c} aria-hidden>
        {[2, 6, 10].map((x) => (
          <rect
            key={x}
            x={x}
            y="6.4"
            width="2.2"
            height="1.2"
            rx=".6"
            fill="currentColor"
            className="text-muted-foreground/60"
          />
        ))}
      </svg>
    );
  return (
    <svg viewBox="0 0 14 14" className={c} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 4}
          y={9 - i * 3}
          width="2.4"
          height={3 + i * 3}
          rx=".8"
          fill="currentColor"
          className={i < level! ? "text-foreground" : "text-muted-foreground/30"}
        />
      ))}
    </svg>
  );
}
