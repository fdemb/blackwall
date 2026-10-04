import { Separator as RACSeparator, type SeparatorProps } from "react-aria-components";
import { cn } from "~/lib/utils";

export function Separator({ className, orientation = "horizontal", ...props }: SeparatorProps) {
  return (
    <RACSeparator
      {...props}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
    />
  );
}
