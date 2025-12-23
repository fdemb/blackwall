import { cn } from "@/lib/utils";
import { Popover } from "@kobalte/core/popover";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { SlashCommandItem } from "./extensions/slash-command";

export type SlashMenuProps = {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
  getAnchorRect: () => DOMRect | null;
  onClose: () => void;
};

export function SlashMenu(props: SlashMenuProps) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command(item);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i <= 0 ? props.items.length - 1 : i - 1));
      return true;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i >= props.items.length - 1 ? 0 : i + 1));
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      selectItem(selectedIndex());
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return true;
    }
    return false;
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  createEffect(() => {
    // Reset selection when items change
    if (props.items.length > 0) {
      setSelectedIndex(0);
    }
  });

  return (
    <Popover open={true} placement="bottom-start" gutter={4}>
      <Popover.Anchor
        class="fixed"
        style={{
          top: `${props.getAnchorRect()?.top ?? 0}px`,
          left: `${props.getAnchorRect()?.left ?? 0}px`,
          width: `${props.getAnchorRect()?.width ?? 0}px`,
          height: `${props.getAnchorRect()?.height ?? 0}px`,
        }}
      />
      <Popover.Portal>
        <Popover.Content
          class="z-50 min-w-[220px] overflow-hidden rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Show
            when={props.items.length > 0}
            fallback={
              <div class="text-muted-foreground px-2 py-1.5 text-sm">
                No results
              </div>
            }
          >
            <For each={props.items}>
              {(item, index) => (
                <button
                  type="button"
                  class={cn(
                    "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                    selectedIndex() === index()
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent hover:text-accent-foreground",
                  )}
                  onClick={() => selectItem(index())}
                  onMouseEnter={() => setSelectedIndex(index())}
                >
                  <Show when={item.icon}>
                    {(icon) => (
                      <span class="text-muted-foreground mt-0.5">
                        {icon()()}
                      </span>
                    )}
                  </Show>
                  <div class="flex flex-col">
                    <span class="font-medium">{item.title}</span>
                    <span class="text-muted-foreground text-xs">
                      {item.description}
                    </span>
                  </div>
                </button>
              )}
            </For>
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
