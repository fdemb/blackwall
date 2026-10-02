import {
  Popover as RACPopover,
  Dialog as RACDialog,
  OverlayArrow,
  composeRenderProps,
  type PopoverProps,
  type DialogProps,
} from "react-aria-components";
import { cn } from "~/lib/utils";

export const popoverSurface =
  "rounded-lg border border-border bg-popover text-popover-foreground shadow-lg shadow-black/10 outline-none dark:shadow-black/40 entering:animate-in entering:fade-in-0 entering:zoom-in-95 exiting:animate-out exiting:fade-out-0 exiting:zoom-out-95 placement-bottom:slide-in-from-top-1 placement-top:slide-in-from-bottom-1";

export function Popover({ className, offset = 6, ...props }: PopoverProps) {
  return (
    <RACPopover
      offset={offset}
      {...props}
      className={composeRenderProps(className, (c) =>
        cn(popoverSurface, "min-w-(--trigger-width)", c),
      )}
    />
  );
}
export function PopoverDialog({ className, ...props }: DialogProps) {
  return <RACDialog {...props} className={cn("outline-none", className)} />;
}
export { OverlayArrow };
