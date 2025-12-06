import { cn } from "@/lib/utils";
import { splitProps, type ComponentProps } from "solid-js";

export function PageHeader(props: ComponentProps<"header">) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <header
      class={cn(
        "px-4 py-2 font-medium border-b flex flex-row items-center h-10 sticky top-0 bg-surface z-10",
        local.class,
      )}
      {...rest}
    />
  );
}
