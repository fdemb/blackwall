import { cn } from "~/lib/utils";

export function Logo({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 8h8a4 4 0 0 1 2.4 7.2A4.5 4.5 0 0 1 17.5 24H9z" fill="white" />
      <path
        d="M13 12.2h3.6a1.4 1.4 0 0 1 0 2.8H13zM13 17h4.2a1.5 1.5 0 0 1 0 3H13z"
        className="fill-primary"
      />
    </svg>
  );
}
