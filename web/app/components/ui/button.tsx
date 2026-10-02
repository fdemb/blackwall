import {
  Button as RACButton,
  composeRenderProps,
  type ButtonProps as RACButtonProps,
} from "react-aria-components";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium outline-none transition-[background-color,color,box-shadow,transform] duration-100 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 pressed:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "bg-primary-solid text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary-solid/90",
        secondary: "border border-input bg-card text-foreground shadow-xs hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground pressed:bg-muted",
        subtle: "bg-accent text-accent-foreground hover:bg-accent/70",
        destructive: "bg-destructive-solid text-white hover:bg-destructive-solid/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 pointer-coarse:h-9",
        md: "h-8 px-3 pointer-coarse:h-10",
        lg: "h-9 px-4 text-sm pointer-coarse:h-11",
        icon: "size-7 pointer-coarse:size-9",
        "icon-lg": "size-8 pointer-coarse:size-10",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends RACButtonProps, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <RACButton
      {...props}
      className={composeRenderProps(className, (className) =>
        cn(buttonVariants({ variant, size }), className),
      )}
    />
  );
}
