import type { ColorKey } from "@/db/schema";
import { cn } from "@/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { splitProps, type ComponentProps } from "solid-js";

export const badgeVariants = cva(
  "px-2 py-1 text-base font-medium rounded-full inline-flex flex-row gap-1 items-center !leading-none shadow-xs",
  {
    variants: {
      size: {
        sm: "text-sm px-1.5 py-1",
        md: "text-base px-2 py-1.5",
      },
      color: {
        normal:
          "bg-gradient-to-b from-background to-surface text-foreground ring-1 ring-foreground/10",
        red: "bg-theme-red text-background ring-1 ring-foreground/10 ring-inset",
        blue: "bg-theme-blue text-background ring-1 ring-foreground/10 ring-inset",
        green:
          "bg-theme-green text-background ring-1 ring-foreground/10 ring-inset",
        orange:
          "bg-theme-orange text-background ring-1 ring-foreground/10 ring-inset",
        pink: "bg-theme-pink text-background ring-1 ring-foreground/10 ring-inset",
        purple:
          "bg-theme-purple text-background ring-1 ring-foreground/10 ring-inset",
        teal: "bg-theme-teal text-background ring-1 ring-foreground/10 ring-inset",
        violet:
          "bg-theme-violet text-background ring-1 ring-foreground/10 ring-inset",
        yellow:
          "bg-theme-yellow text-background ring-1 ring-foreground/10 ring-inset",
        // blue: "bg-gradient-to-b from-blue-50 to-blue-100 ring-1 ring-blue-600/20 shadow-blue-500/20 text-blue-950",
        // green:
        //   "bg-gradient-to-b from-emerald-50 to-emerald-100 ring-1 ring-emerald-600/20 shadow-emerald-500/20 text-emerald-950",
        // red: "bg-gradient-to-b from-red-50 to-red-100 ring-1 ring-red-600/20 shadow-red-500/20 text-red-950",
        // yellow:
        //   "bg-gradient-to-b from-yellow-50 to-yellow-100 ring-1 ring-yellow-600/20 shadow-yellow-500/20 text-yellow-950",
        // purple:
        //   "bg-gradient-to-b from-purple-50 to-purple-100 ring-1 ring-purple-600/20 shadow-purple-500/20 text-purple-950",
        // amber:
        //   "bg-gradient-to-b from-amber-50 to-amber-100 ring-1 ring-amber-600/20 shadow-amber-500/20 text-amber-950",
        // cyan: "bg-gradient-to-b from-cyan-50 to-cyan-100 ring-1 ring-cyan-600/20 shadow-cyan-500/20 text-cyan-950",
        // emerald:
        //   "bg-gradient-to-b from-emerald-50 to-emerald-100 ring-1 ring-emerald-600/20 shadow-emerald-500/20 text-emerald-950",
        // fuchsia:
        //   "bg-gradient-to-b from-fuchsia-50 to-fuchsia-100 ring-1 ring-fuchsia-600/20 shadow-fuchsia-500/20 text-fuchsia-950",
        // gray: "bg-gradient-to-b from-gray-50 to-gray-100 ring-1 ring-gray-600/20 shadow-gray-500/20 text-gray-950",
        // indigo:
        //   "bg-gradient-to-b from-indigo-50 to-indigo-100 ring-1 ring-indigo-600/20 shadow-indigo-500/20 text-indigo-950",
        // lime: "bg-gradient-to-b from-lime-50 to-lime-100 ring-1 ring-lime-600/20 shadow-lime-500/20 text-lime-950",
        // orange:
        //   "bg-gradient-to-b from-orange-50 to-orange-100 ring-1 ring-orange-600/20 shadow-orange-500/20 text-orange-950",
        // pink: "bg-gradient-to-b from-pink-50 to-pink-100 ring-1 ring-pink-600/20 shadow-pink-500/20 text-pink-950",
        // rose: "bg-gradient-to-b from-rose-50 to-rose-100 ring-1 ring-rose-600/20 shadow-rose-500/20 text-rose-950",
        // sky: "bg-gradient-to-b from-sky-50 to-sky-100 ring-1 ring-sky-600/20 shadow-sky-500/20 text-sky-950",
        // teal: "bg-gradient-to-b from-teal-50 to-teal-100 ring-1 ring-teal-600/20 shadow-teal-500/20 text-teal-950",
        // violet:
        //   "bg-gradient-to-b from-violet-50 to-violet-100 ring-1 ring-violet-600/20 shadow-violet-500/20 text-violet-950",
        // slate:
        //   "bg-gradient-to-b from-slate-100 to-slate-50 ring-1 ring-slate-600/20 shadow-slate-500/20 text-slate-950",
      } satisfies Record<ColorKey | "normal", string>,
    },
    defaultVariants: {
      color: "normal",
      size: "md",
    },
  },
);

export function Badge(
  props: ComponentProps<"span"> & VariantProps<typeof badgeVariants>,
) {
  const [local, rest] = splitProps(props, ["class", "color", "size"]);

  return (
    <span
      class={cn(
        badgeVariants({ color: local.color, size: local.size }),
        local.class,
      )}
      {...rest}
    />
  );
}
