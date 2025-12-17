import { cn } from "@/lib/utils";
import {
  Button as ButtonPrimitive,
  type ButtonRootProps,
} from "@kobalte/core/button";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cva, type VariantProps } from "class-variance-authority";
import * as Solid from "solid-js";

const buttonVariants = cva(
  "squircle-sm inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-transform ease-in-expo disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-b from-primary to-primary-darker ring-inset ring-[0.5px] ring-white/50 border border-black/20 text-primary-foreground shadow-xs hover:from-primary/95 hover:to-primary/95",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "ring-1 ring-foreground/12 bg-gradient-to-b from-background to-surface shadow-xs hover:from-accent hover:to-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground ring-1 ring-transparent hover:ring-black/10 dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3 text-sm",
        xs: "h-7 px-2 py-1 has-[>svg]:px-2 text-sm",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5 text-sm",
        lg: "h-9 px-6 has-[>svg]:px-4 text-base",
        icon: "size-9",
        iconSm: "size-8",
        iconXs: "size-7",
      },
      scaleEffect: {
        true: "active:scale-[0.97] aria-expanded:scale-[0.97] will-change-[scale]",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      scaleEffect: true,
    },
  },
);

const Button = <T extends Solid.ValidComponent = "button">(
  props: PolymorphicProps<T, ButtonRootProps<T>> &
    VariantProps<typeof buttonVariants>,
) => {
  const [local, rest] = Solid.splitProps(props as any, [
    "class",
    "variant",
    "size",
    "scaleEffect",
  ]);

  return (
    <ButtonPrimitive
      class={cn(
        buttonVariants({
          scaleEffect: local.scaleEffect,
          variant: local.variant,
          size: local.size,
        }),
        local.class,
      )}
      {...rest}
    />
  );
};

export { Button, buttonVariants };
