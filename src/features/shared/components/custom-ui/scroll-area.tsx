import * as scrollArea from "@zag-js/scroll-area";
import { normalizeProps, useMachine } from "@zag-js/solid";
import { createMemo, createUniqueId, Show, type JSX } from "solid-js";

export function ScrollArea(props: { children?: JSX.Element }) {
  const service = useMachine(scrollArea.machine, {
    id: createUniqueId(),
  });

  const api = createMemo(() => scrollArea.connect(service, normalizeProps));

  return (
    <div
      {...api().getRootProps()}
      class="flex-1 flex flex-col overflow-hidden max-h-full group/scrollarea"
    >
      <div
        {...api().getViewportProps()}
        class="w-full h-full [scrollbar-width:none] flex-1 flex flex-col"
      >
        <div {...api().getContentProps()} class="w-full flex-1">
          {props.children}
        </div>
      </div>
      <Show when={api().hasOverflowY}>
        <div
          {...api().getScrollbarProps()}
          class="w-1.5 bg-transparent flex justify-center group-hover/scrollarea:opacity-100 opacity-0 duration-100 transition-opacity"
        >
          <div {...api().getThumbProps()} class="w-full bg-stone-500/10" />
        </div>
      </Show>
    </div>
  );
}
