import { cn } from "@/lib/utils";
import { ClientOnly } from "@tanstack/solid-router";
import { Editor, type Content, type JSONContent } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { StarterKit } from "@tiptap/starter-kit";
import { renderToHTMLString } from "@tiptap/static-renderer";
import { cva, type VariantProps } from "class-variance-authority";
import CodeIcon from "lucide-solid/icons/code";
import Heading1Icon from "lucide-solid/icons/heading-1";
import Heading2Icon from "lucide-solid/icons/heading-2";
import ImageIcon from "lucide-solid/icons/image";
import ListIcon from "lucide-solid/icons/list";
import ListOrderedIcon from "lucide-solid/icons/list-ordered";
import QuoteIcon from "lucide-solid/icons/quote";
import {
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  on,
  onCleanup,
} from "solid-js";
import {
  SlashCommand,
  type SlashCommandItem,
} from "./extensions/slash-command";
import { createSuggestionRenderer } from "./suggestion-renderer";

export type TiptapProps = {
  initialContent?: Content;
  content?: JSONContent;
  onChange?: (content: JSONContent) => void;
  onBlur?: (content: JSONContent) => void;
  onAttachmentUpload?: (file: File) => Promise<{ id: string } | null>;
  workspaceSlug?: string;
  placeholder?: string;
  class?: string;
  editable?: boolean;
  onPointerDown?: (e: PointerEvent) => void;
};

const tiptapVariants = cva("", {
  variants: {
    variant: {
      plain: "prose outline-none",
      input:
        "prose border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
    },
  },
  defaultVariants: {
    variant: "input",
  },
});

export const TiptapEditor = (
  props: TiptapProps & VariantProps<typeof tiptapVariants>,
) => {
  const merged = mergeProps(
    {
      editable: true,
    },
    props,
  );

  const [element, setElement] = createSignal<HTMLDivElement | null>(null);
  const [editor, setEditor] = createSignal<Editor | null>(null);
  const emptyParagraph = () =>
    `<p data-placeholder="${merged.placeholder}" class="is-empty is-editor-empty"></p>`;

  const html = createMemo(() => {
    if (!merged.content && !merged.initialContent) return emptyParagraph();

    if (
      !merged.content &&
      merged.initialContent &&
      typeof merged.initialContent === "string"
    ) {
      return merged.initialContent;
    }

    const result = renderToHTMLString({
      content: merged.content || (merged.initialContent as JSONContent),
      extensions: [
        StarterKit,
        Image,
        Placeholder.configure({ placeholder: merged.placeholder }),
      ],
    });

    if (result === "") {
      return emptyParagraph();
    }

    return result;
  });

  const triggerFileUpload = (
    editor: Editor,
    range: { from: number; to: number },
  ) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !merged.onAttachmentUpload) return;

      // Delete the slash command text
      editor.chain().focus().deleteRange(range).run();

      const result = await merged.onAttachmentUpload(file);
      if (result && merged.workspaceSlug) {
        editor
          .chain()
          .focus()
          .setImage({
            src: `/${merged.workspaceSlug}/issue-attachment/${result.id}`,
          })
          .run();
      }
    };
    input.click();
  };

  const getSlashCommandItems = (query: string): SlashCommandItem[] => {
    const items: SlashCommandItem[] = [
      {
        title: "Image",
        description: "Upload an image",
        icon: () => <ImageIcon class="size-4" />,
        command: ({ editor, range }) => triggerFileUpload(editor, range),
      },
      {
        title: "Heading 1",
        description: "Large heading",
        icon: () => <Heading1Icon class="size-4" />,
        command: ({ editor, range }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode("heading", { level: 1 })
            .run();
        },
      },
      {
        title: "Heading 2",
        description: "Medium heading",
        icon: () => <Heading2Icon class="size-4" />,
        command: ({ editor, range }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .setNode("heading", { level: 2 })
            .run();
        },
      },
      {
        title: "Bullet List",
        description: "Create a bullet list",
        icon: () => <ListIcon class="size-4" />,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleBulletList().run();
        },
      },
      {
        title: "Numbered List",
        description: "Create a numbered list",
        icon: () => <ListOrderedIcon class="size-4" />,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleOrderedList().run();
        },
      },
      {
        title: "Code Block",
        description: "Add a code block",
        icon: () => <CodeIcon class="size-4" />,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
        },
      },
      {
        title: "Quote",
        description: "Add a blockquote",
        icon: () => <QuoteIcon class="size-4" />,
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).toggleBlockquote().run();
        },
      },
    ];

    if (!query) return items;

    return items.filter((item) =>
      item.title.toLowerCase().includes(query.toLowerCase()),
    );
  };

  createEffect(
    on(element, (element) => {
      const suggestionRenderer = createSuggestionRenderer();

      setEditor(
        () =>
          new Editor({
            element: element,
            extensions: [
              StarterKit.configure({
                trailingNode: false,
              }),
              Image,
              Placeholder.configure({ placeholder: merged.placeholder }),
              SlashCommand.configure({
                suggestion: {
                  items: ({ query }) => getSlashCommandItems(query),
                  render: () => suggestionRenderer,
                },
              }),
            ],
            content: merged.initialContent,
            editable: merged.editable,
            editorProps: {
              attributes: {
                class: tiptapVariants({
                  variant: merged.variant,
                  class: merged.class,
                }),
              },
            },
          }),
      );

      editor()?.on("blur", ({ editor }) => {
        if (merged.onBlur) {
          merged.onBlur(editor.getJSON());
        }
      });

      editor()?.on("update", ({ editor, transaction }) => {
        if (merged.onChange && transaction.steps.length > 0) {
          merged.onChange(editor.getJSON());
        }
      });
    }),
  );

  onCleanup(() => {
    editor()?.destroy();
  });

  createEffect(() => {
    if (merged.content) {
      const selection = editor()?.state.selection;

      editor()
        ?.chain()
        .setContent(merged.content)
        .setTextSelection({
          from: selection?.from ?? 0,
          to: selection?.from ?? 0,
        })
        .run();
    }
  });

  createEffect(() => {
    editor()?.setEditable(merged.editable);
  });

  return (
    <>
      <ClientOnly
        fallback={
          <div
            class="w-full h-full whitespace-pre-wrap wrap-break-word"
            data-fallback
          >
            <div
              class={cn(
                tiptapVariants({ variant: merged.variant }),
                merged.class,
              )}
              innerHTML={html()}
            />
          </div>
        }
      >
        <div
          ref={(el) => {
            setElement(el);
          }}
          class="w-full h-full"
          onPointerDown={props.onPointerDown}
        />
      </ClientOnly>
    </>
  );
};
