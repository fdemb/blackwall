import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Editor, Range } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import { Avatar } from "~/components/ui/avatar";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { MemberProfile } from "~/lib/types";
import {
  codec,
  contentExtensions,
  SLASH_COMMANDS,
  submitShortcut,
  suggestionMenu,
  SuggestionBridge,
  type BlockType,
  type SuggestionSession,
} from "./extensions";
import { SelectionToolbar } from "./toolbar";
import { SuggestionList } from "./suggestion-list";

export interface MarkdownEditorHandle {
  focus: () => void;
}

export interface MarkdownEditorProps {
  ref?: React.Ref<MarkdownEditorHandle>;
  value: string;
  onChange: (markdown: string) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  /** Offers `@` to mention a workspace member. */
  mentions?: boolean;
  editable?: boolean;
  /** `boxed` draws a field border, for comment boxes. `plain` blends into the page, like Notion. */
  appearance?: "boxed" | "plain";
  /** Classes for the editable area, such as a minimum height. */
  className?: string;
}

const MAX_MENTIONS = 8;

/**
 * WYSIWYG markdown editor. Type `/` for blocks, `@` for people, or markdown shortcuts such as `# `
 * and `- `. Selecting text shows a formatting toolbar. Reads and writes markdown, so stored text
 * and the API stay plain.
 */
export function MarkdownEditor({
  ref,
  value,
  onChange,
  label,
  placeholder,
  autoFocus,
  onSubmit,
  mentions = true,
  editable = true,
  appearance = "boxed",
  className,
}: MarkdownEditorProps) {
  const { t } = useI18n();
  const { members } = useWorkspace();
  const [callbacks] = useState(() => new Callbacks({ onChange, onSubmit, placeholder, t }));
  useEffect(() => callbacks.sync({ onChange, onSubmit, placeholder, t }));
  // The markdown this editor last produced or loaded, so echoes of our own edits don't reset it.
  const emitted = useRef(value);
  const [slash, setSlash] = useState<SuggestionSession | null>(null);
  const [mention, setMention] = useState<SuggestionSession | null>(null);
  const [bridges] = useState(() => ({
    slash: new SuggestionBridge(setSlash),
    mention: new SuggestionBridge(setMention),
  }));

  const editor = useEditor({
    extensions: [
      ...contentExtensions,
      Placeholder.configure({
        placeholder: ({ editor: e, node }) => callbacks.placeholder(e.isEmpty, node.type.name),
      }),
      submitShortcut(() => callbacks.submit()),
      suggestionMenu("slashMenu", "/", bridges.slash, (e, range, item) =>
        (item as BlockType).apply(e.chain().focus().deleteRange(range)).run(),
      ),
      ...(mentions ? [suggestionMenu("mentionMenu", "@", bridges.mention, insertMention)] : []),
    ],
    content: codec.parse(value),
    editable,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        "aria-label": label,
        "aria-multiline": "true",
        role: "textbox",
        class: cn(
          "prose-bw bw-editor min-h-6 outline-none",
          appearance === "boxed" && "px-3 py-2.5",
          className,
        ),
      },
      // Links stay editable text; Ctrl/Cmd+click follows them, as in Notion.
      handleClick: (_view, _pos, event) => {
        const a = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!a || !(event.metaKey || event.ctrlKey)) return false;
        window.open(a.getAttribute("href") ?? "", "_blank", "noopener,noreferrer");
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = codec.serialize(e.getJSON());
      emitted.current = md;
      callbacks.change(md);
    },
  });

  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus("start") }), [editor]);
  // Text set from outside, such as a cleared comment box or a teammate's edit, replaces the doc.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.commands.setContent(codec.parse(value), { emitUpdate: false });
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  const query = (s: SuggestionSession | null) => s?.query.toLocaleLowerCase() ?? "";
  const commands = SLASH_COMMANDS.filter((c) =>
    `${t(c.label)} ${c.keywords}`.toLocaleLowerCase().includes(query(slash)),
  );
  const people = members
    .filter((m) => m.display_name.toLocaleLowerCase().includes(query(mention)))
    .slice(0, MAX_MENTIONS);

  return (
    <div
      // Tab indents lists and moves between table cells. A dialog's focus trap must not also act on it.
      onKeyDown={(e) => {
        if (e.key === "Tab" && e.defaultPrevented) e.stopPropagation();
      }}
      className={cn(
        "relative min-w-0 text-[14px]",
        appearance === "boxed" &&
          "rounded-lg border border-input bg-card shadow-xs transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25",
      )}
    >
      <EditorContent editor={editor} />
      {editor && <SelectionToolbar editor={editor} />}
      <SuggestionList
        session={slash}
        items={commands}
        itemKey={(c) => c.id}
        bridge={bridges.slash}
        label={t("editor.blocks")}
        empty={t("search.empty")}
        renderItem={(c) => (
          <>
            <span className="grid size-6 place-items-center rounded-md border border-border bg-card">
              <c.icon aria-hidden className="size-3.5 text-muted-foreground" />
            </span>
            {t(c.label)}
          </>
        )}
      />
      {mentions && (
        <SuggestionList
          session={mention}
          items={people}
          itemKey={(m) => m.id}
          bridge={bridges.mention}
          label={t("editor.mention")}
          empty={t("search.empty")}
          renderItem={(m) => (
            <>
              <Avatar name={m.display_name} src={m.avatar_url} size={18} />
              <span className="truncate">{m.display_name}</span>
            </>
          )}
        />
      )}
    </div>
  );
}

interface Latest {
  onChange: (markdown: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  t: ReturnType<typeof useI18n>["t"];
}

/** What the editor's plugins call into. Synced after each render, read only from editor events. */
class Callbacks {
  constructor(private latest: Latest) {}
  sync(latest: Latest) {
    this.latest = latest;
  }
  change(markdown: string) {
    this.latest.onChange(markdown);
  }
  submit() {
    this.latest.onSubmit?.();
    return this.latest.onSubmit !== undefined;
  }
  placeholder(docEmpty: boolean, nodeType: string) {
    const { placeholder, t } = this.latest;
    if (docEmpty && placeholder) return placeholder;
    return nodeType === "heading" ? t("editor.heading") : t("editor.slashHint");
  }
}

/** Mentions stay plain `@Name` text, which is what comments already store and notify on. */
function insertMention(editor: Editor, range: Range, item: unknown) {
  const m = item as MemberProfile;
  editor
    .chain()
    .focus()
    .insertContentAt(range, [{ type: "text", text: `@${m.display_name} ` }])
    .run();
}
