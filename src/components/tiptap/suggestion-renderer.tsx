import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { SlashCommandItem } from "./extensions/slash-command";
import { SlashMenu } from "./slash-menu";

type SuggestionRenderer = {
  onStart: (props: SuggestionProps<SlashCommandItem>) => void;
  onUpdate: (props: SuggestionProps<SlashCommandItem>) => void;
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
  onExit: () => void;
};

export function createSuggestionRenderer(): SuggestionRenderer {
  let container: HTMLDivElement | null = null;
  let dispose: (() => void) | null = null;
  const [currentProps, setCurrentProps] =
    createSignal<SuggestionProps<SlashCommandItem> | null>(null);

  const cleanup = () => {
    if (dispose) dispose();
    if (container) {
      container.remove();
      container = null;
    }
    setCurrentProps(null);
  };

  const renderMenu = () => {
    if (!container) {
      container = document.createElement("div");
      document.body.appendChild(container);
    }

    dispose = render(
      () => (
        <SlashMenu
          items={currentProps()?.items ?? []}
          command={(item) => currentProps()?.command(item)}
          getAnchorRect={() => currentProps()?.clientRect?.() ?? null}
          onClose={cleanup}
        />
      ),
      container,
    );
  };

  return {
    onStart: (props: SuggestionProps<SlashCommandItem>) => {
      setCurrentProps(props);
      renderMenu();
    },

    onUpdate: (props: SuggestionProps<SlashCommandItem>) => {
      setCurrentProps(props);
    },

    onKeyDown: (props: SuggestionKeyDownProps) => {
      if (props.event.key === "Escape") {
        cleanup();
        return true;
      }
      // Let the menu component handle arrow keys and enter
      if (["ArrowUp", "ArrowDown", "Enter"].includes(props.event.key)) {
        return true;
      }
      return false;
    },

    onExit: cleanup,
  };
}
