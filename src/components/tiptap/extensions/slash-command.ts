import { Extension, type Editor, type Range } from "@tiptap/core";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import type { JSX } from "solid-js";

export type SlashCommandItem = {
  title: string;
  description: string;
  icon?: () => JSX.Element;
  command: (props: { editor: Editor; range: Range }) => void;
};

export type SlashCommandOptions = {
  suggestion: Partial<SuggestionOptions<SlashCommandItem>>;
};

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
