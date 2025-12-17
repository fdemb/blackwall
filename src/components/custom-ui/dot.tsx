import type { ColorKey } from "@/db/schema";
import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { splitProps, type ComponentProps } from "solid-js";

export const dotVariants = cva("rounded-full", {
  variants: {
    color: {
      normal:
        "bg-gradient-to-b from-background to-surface ring-1 ring-black/10",
      blue: "bg-gradient-to-b from-blue-100 to-blue-50 ring-1 ring-blue-600/20",
      green:
        "bg-gradient-to-b from-emerald-100 to-emerald-50 ring-1 ring-emerald-600/20",
      red: "bg-gradient-to-b from-red-100 to-red-50 ring-1 ring-red-600/20",
      yellow:
        "bg-gradient-to-b from-yellow-100 to-yellow-50 ring-1 ring-yellow-600/20",
      purple:
        "bg-gradient-to-b from-purple-100 to-purple-50 ring-1 ring-purple-600/20",
      pink: "bg-gradient-to-b from-pink-100 to-pink-50 ring-1 ring-pink-600/20",
      teal: "bg-gradient-to-b from-teal-100 to-teal-50 ring-1 ring-teal-600/20",
      violet:
        "bg-gradient-to-b from-violet-100 to-violet-50 ring-1 ring-violet-600/20",
      orange: "bg-theme-orange ring-1 ring-foreground/10 ring-inset",
    } satisfies Record<ColorKey | "normal", string>,
    size: {
      xs: "w-1 h-1",
      sm: "w-1.5 h-1.5",
      md: "w-2 h-2",
      lg: "w-2.5 h-2.5",
      xl: "w-3 h-3",
    },
  },
  defaultVariants: {
    color: "normal",
    size: "md",
  },
});

export function Dot(
  props: ComponentProps<"span"> & VariantProps<typeof dotVariants>,
) {
  const [local, rest] = splitProps(props, ["class", "color", "size"]);

  return (
    <span
      class={cn(
        dotVariants({ color: local.color, size: local.size }),
        local.class,
      )}
      {...rest}
    />
  );
}
