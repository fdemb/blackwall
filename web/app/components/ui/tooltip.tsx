import { Tooltip as RACTooltip, TooltipTrigger, composeRenderProps, type TooltipProps } from "react-aria-components";
import { cn } from "~/lib/utils";

export function Tip({ children, label, ...props }: { children: React.ReactNode; label: React.ReactNode } & Omit<TooltipProps, "children">) {
  return (
    <TooltipTrigger delay={400} closeDelay={0}>
      {children}
      <RACTooltip
        offset={6}
        {...props}
        className={composeRenderProps(props.className, (c) =>
          cn("z-50 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0", c),
        )}
      >
        {label}
      </RACTooltip>
    </TooltipTrigger>
  );
}
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground", className)}>
      {children}
    </kbd>
  );
}
