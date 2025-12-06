import { cn } from "@/lib/utils";
import { cva, VariantProps } from "class-variance-authority";
import { splitProps, type ComponentProps } from "solid-js";

const kbdVariants = cva(
  "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center font-mono justify-center gap-1 rounded-sm px-1 text-xs font-medium select-none [&_svg:not([class*='size-'])]:size-3 [[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10",
  {
    variants: {
      variant: {
        default: "bg-muted text-muted-foreground",
        onPrimary:
          "text-primary-foreground border border-primary-foreground/20 bg-primary-foreground/10",
      },
      size: {
        default: "h-5 w-fit min-w-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Kbd(props: ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  const [local, rest] = splitProps(props, ["class", "variant", "size"]);
  return (
    <kbd
      data-slot="kbd"
      class={cn(
        kbdVariants({ variant: local.variant, size: local.size }),
        local.class,
      )}
      {...rest}
    />
  );
}

function KbdGroup(props: ComponentProps<"div">) {
  const [local, rest] = splitProps(props, ["class"]);

  return (
    <kbd
      data-slot="kbd-group"
      class={cn("inline-flex items-center gap-1", local.class)}
      {...rest}
    />
  );
}
export { Kbd, KbdGroup };
