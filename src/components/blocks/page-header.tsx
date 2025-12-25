import { cn } from "@/lib/utils";
import PanelLeftIcon from "lucide-solid/icons/panel-left";
import { splitProps, type ComponentProps } from "solid-js";
import { SidebarTrigger } from "../ui/sidebar";

export function PageHeader(props: ComponentProps<"header">) {
  const [local, rest] = splitProps(props, ["class", "children"]);

  return (
    <>
      <header
        class={cn(
          "px-3 h-10 font-medium border-b flex flex-row items-center fixed w-full top-0 bg-surface z-10 gap-2",
          local.class,
        )}
        {...rest}
      >
        <SidebarTrigger side="left" class="md:hidden">
          <PanelLeftIcon class="size-4" />
        </SidebarTrigger>

        {local.children}
      </header>
      <div class="h-10 w-full" role="none" />
    </>
  );
}
