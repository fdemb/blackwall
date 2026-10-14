import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Check, ChevronDown, Code, Italic, Link2, Strikethrough, Unlink } from "lucide-react";
import { popoverSurface } from "~/components/ui/popover";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";
import { TEXT_BLOCKS } from "./extensions";

const MARKS = [
  { id: "bold", icon: Bold, label: "editor.bold", toggle: "toggleBold" },
  { id: "italic", icon: Italic, label: "editor.italic", toggle: "toggleItalic" },
  { id: "strike", icon: Strikethrough, label: "editor.strike", toggle: "toggleStrike" },
  { id: "code", icon: Code, label: "editor.code", toggle: "toggleCode" },
] as const;

type Mode = "marks" | "blocks" | "link";

/**
 * Floats over selected text: inline marks, a link field, and "turn into" for the block. Controls
 * keep focus in the editor (or inside the toolbar, for the link field), so it never counts as a blur.
 */
export function SelectionToolbar({ editor }: { editor: Editor }) {
  const [mode, setMode] = useState<Mode>("marks");
  return (
    <BubbleMenu
      editor={editor}
      options={{ strategy: "fixed", placement: "top", onHide: () => setMode("marks") }}
      shouldShow={({ editor: e, view, element, state }) =>
        e.isEditable &&
        state.selection instanceof TextSelection &&
        !state.selection.empty &&
        !e.isActive("codeBlock") &&
        (view.hasFocus() || element.contains(document.activeElement))
      }
      className={cn(popoverSurface, "z-50 flex items-center gap-0.5 p-1")}
    >
      {mode === "link" ? (
        <LinkField editor={editor} onDone={() => setMode("marks")} />
      ) : (
        <Marks
          editor={editor}
          blocksOpen={mode === "blocks"}
          onMode={(m) => setMode(m === mode ? "marks" : m)}
        />
      )}
    </BubbleMenu>
  );
}

function Marks({
  editor,
  blocksOpen,
  onMode,
}: {
  editor: Editor;
  blocksOpen: boolean;
  onMode: (mode: Mode) => void;
}) {
  const { t } = useI18n();
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      marks: MARKS.map((m) => e.isActive(m.id)),
      link: e.isActive("link"),
      block: TEXT_BLOCKS.filter((b) => b.isActive?.(e)).at(-1)?.id ?? "text",
    }),
  });
  const block = TEXT_BLOCKS.find((b) => b.id === active.block) ?? TEXT_BLOCKS[0]!;
  return (
    <div className="relative flex items-center gap-0.5">
      <ToolButton
        label={t("editor.turnInto")}
        onPress={() => onMode("blocks")}
        pressed={blocksOpen}
      >
        <block.icon aria-hidden className="size-3.5" />
        <ChevronDown aria-hidden className="size-3" />
      </ToolButton>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      {MARKS.map((m, i) => (
        <ToolButton
          key={m.id}
          label={t(m.label)}
          pressed={active.marks[i]}
          onPress={() => editor.chain().focus()[m.toggle]().run()}
        >
          <m.icon aria-hidden className="size-3.5" />
        </ToolButton>
      ))}
      <ToolButton
        label={active.link ? t("editor.removeLink") : t("editor.link")}
        pressed={active.link}
        onPress={() =>
          active.link
            ? editor.chain().focus().extendMarkRange("link").unsetLink().run()
            : onMode("link")
        }
      >
        {active.link ? (
          <Unlink aria-hidden className="size-3.5" />
        ) : (
          <Link2 aria-hidden className="size-3.5" />
        )}
      </ToolButton>
      {blocksOpen && (
        <div
          role="menu"
          aria-label={t("editor.turnInto")}
          className={cn(popoverSurface, "absolute left-0 top-full mt-2 min-w-44 p-1")}
        >
          {TEXT_BLOCKS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                b.apply(editor.chain().focus()).run();
                onMode("blocks");
              }}
              className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            >
              <b.icon aria-hidden className="size-4 text-muted-foreground" />
              <span className="flex-1">{t(b.label)}</span>
              {b.id === active.block && <Check aria-hidden className="size-3.5 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkField({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const { t } = useI18n();
  const [href, setHref] = useState("");
  const apply = () => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    (url ? chain.setLink({ href: url }) : chain.unsetLink()).run();
    onDone();
  };
  return (
    <input
      autoFocus
      type="url"
      aria-label={t("editor.link")}
      placeholder={t("editor.linkPlaceholder")}
      value={href}
      onChange={(e) => setHref(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          apply();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          editor.commands.focus();
          onDone();
        }
      }}
      className="h-7 w-64 bg-transparent px-2 outline-none placeholder:text-muted-foreground/70"
    />
  );
}

function ToolButton({
  label,
  pressed,
  onPress,
  children,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        "inline-flex h-7 min-w-7 cursor-default items-center justify-center gap-0.5 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
        pressed && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
