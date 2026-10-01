import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const badgeVariants = cva("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      primary: "bg-accent text-accent-foreground",
      success: "bg-success/15 text-success",
      warning: "bg-warning/20 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]",
      danger: "bg-destructive/12 text-destructive",
      outline: "border border-border text-muted-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span {...props} className={cn(badgeVariants({ tone }), className)} />;
}
