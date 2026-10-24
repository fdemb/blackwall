import { useId } from "react";
import { cn } from "~/lib/utils";

export function Logo({ className, size = 24 }: { className?: string; size?: number }) {
  const gradient = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fdba74" />
          <stop offset="1" stopColor="#fb7185" />
        </linearGradient>
      </defs>
      <g className="fill-foreground">
        <rect x="1" y="3.5" width="14" height="7" rx="1.5" />
        <rect x="17" y="3.5" width="14" height="7" rx="1.5" />
        <rect x="1" y="12.5" width="6" height="7" rx="1.5" />
        <rect x="25" y="12.5" width="6" height="7" rx="1.5" />
        <rect x="1" y="21.5" width="14" height="7" rx="1.5" />
        <rect x="17" y="21.5" width="14" height="7" rx="1.5" />
      </g>
      <rect x="9" y="12.5" width="14" height="7" rx="1.5" fill={`url(#${gradient})`} />
    </svg>
  );
}
