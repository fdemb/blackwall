import { Extension, type ChainedCommands, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import Suggestion, { type SuggestionMount } from "@tiptap/suggestion";
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Table,
  type LucideIcon,
} from "lucide-react";
import type { Key } from "~/lib/i18n";
import { markdownCodec } from "./markdown-codec";

/** The document schema. Everything here has a markdown form the backend renders. */
export const contentExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // pulldown-cmark has no underline syntax, so it would not survive a save.
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
    },
  }),
  TableKit.configure({ table: { resizable: false } }),
];

export const codec = markdownCodec(contentExtensions);

export interface BlockType {
  id: string;
  label: Key;
  icon: LucideIcon;
  /** Extra words the slash menu matches on. */
  keywords: string;
  apply: (chain: ChainedCommands) => ChainedCommands;
  isActive?: (editor: Editor) => boolean;
}

/**
 * Blocks a paragraph can turn into, offered by both the slash menu and the selection toolbar.
 * Ordered from plain to specific: the last active entry names the block the cursor is in.
 */
export const TEXT_BLOCKS: BlockType[] = [
  {
    id: "text",
    label: "editor.text",
    icon: Pilcrow,
    keywords: "paragraph plain",
    apply: (c) => c.clearNodes().setParagraph(),
    isActive: (e) => e.isActive("paragraph"),
  },
  ...([1, 2, 3] as const).map((level): BlockType => ({
    id: `h${level}`,
    label: `editor.heading${level}`,
    icon: [Heading1, Heading2, Heading3][level - 1]!,
    keywords: `h${level} heading title`,
    apply: (c) => c.clearNodes().setHeading({ level }),
    isActive: (e) => e.isActive("heading", { level }),
  })),
  {
    id: "bullet",
    label: "editor.list",
    icon: List,
    keywords: "ul unordered bullet",
    apply: (c) => c.toggleBulletList(),
    isActive: (e) => e.isActive("bulletList"),
  },
  {
    id: "numbered",
    label: "editor.numbered",
    icon: ListOrdered,
    keywords: "ol ordered number",
    apply: (c) => c.toggleOrderedList(),
    isActive: (e) => e.isActive("orderedList"),
  },
  {
    id: "quote",
    label: "editor.quote",
    icon: Quote,
    keywords: "blockquote citation",
    apply: (c) => c.toggleBlockquote(),
    isActive: (e) => e.isActive("blockquote"),
  },
  {
    id: "code",
    label: "editor.codeBlock",
    icon: Code2,
    keywords: "pre snippet",
    apply: (c) => c.toggleCodeBlock(),
    isActive: (e) => e.isActive("codeBlock"),
  },
];

export const SLASH_COMMANDS: BlockType[] = [
  ...TEXT_BLOCKS,
  {
    id: "divider",
    label: "editor.divider",
    icon: Minus,
    keywords: "hr rule separator line",
    apply: (c) => c.setHorizontalRule(),
  },
  {
    id: "table",
    label: "editor.table",
    icon: Table,
    keywords: "grid columns rows",
    apply: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
];

/** An open suggestion, such as the slash menu, as the React popup sees it. */
export interface SuggestionSession {
  query: string;
  pick: (item: unknown) => void;
  mount: SuggestionMount;
}

/**
 * Connects a suggestion plugin to the React popup that renders it. The plugin pushes sessions out
 * through `open`; the popup registers how it handles keys.
 */
export class SuggestionBridge {
  private handleKey: (event: KeyboardEvent) => boolean = () => false;
  constructor(readonly open: (session: SuggestionSession | null) => void) {}
  keyDown(event: KeyboardEvent) {
    return this.handleKey(event);
  }
  onKey(handle: (event: KeyboardEvent) => boolean) {
    this.handleKey = handle;
  }
}

/**
 * A menu that opens when `char` is typed at the start of a word, like `/` for blocks or `@` for
 * people. The popup lives in React; `bridge` carries the session there and keys back.
 */
export function suggestionMenu(
  name: string,
  char: string,
  bridge: SuggestionBridge,
  apply: (editor: Editor, range: Range, item: unknown) => void,
) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: new PluginKey(name),
          char,
          floatingUi: { strategy: "fixed" },
          allow: ({ editor }) => !editor.isActive("codeBlock") && !editor.isActive("code"),
          command: ({ editor, range, props }) => apply(editor, range, props),
          render: () => {
            let mount: SuggestionMount | undefined;
            return {
              onStart: (p) => {
                mount = p.mount;
                bridge.open({ query: p.query, pick: p.command, mount });
              },
              onUpdate: (p) =>
                bridge.open({ query: p.query, pick: p.command, mount: mount ?? p.mount }),
              onExit: () => bridge.open(null),
              onKeyDown: ({ event }) => {
                // Escape closes the menu, not the dialog the editor sits in.
                if (event.key === "Escape") event.stopPropagation();
                return bridge.keyDown(event);
              },
            };
          },
        }),
      ];
    },
  });
}

/** Ctrl/Cmd+Enter submits. Returns false when there is nothing to submit, so the key passes on. */
export function submitShortcut(submit: () => boolean) {
  return Extension.create({
    name: "submitShortcut",
    addKeyboardShortcuts() {
      return { "Mod-Enter": submit };
    },
  });
}
