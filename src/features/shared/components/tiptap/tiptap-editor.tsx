import { cn } from "@/lib/utils";
import { ClientOnly } from "@tanstack/solid-router";
import { Editor, type Content, type JSONContent } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { StarterKit } from "@tiptap/starter-kit";
import { renderToHTMLString } from "@tiptap/static-renderer";
import { cva, type VariantProps } from "class-variance-authority";
import {
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  on,
  onCleanup,
} from "solid-js";

export type TiptapProps = {
  initialContent?: Content;
  content?: JSONContent;
  onChange?: (content: JSONContent) => void;
  onBlur?: (content: JSONContent) => void;
  placeholder?: string;
  class?: string;
  editable?: boolean;
  editableOnClick?: boolean;
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
      editableOnClick: false,
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
        Placeholder.configure({ placeholder: merged.placeholder }),
      ],
    });

    if (result === "") {
      return emptyParagraph();
    }

    return result;
  });

  function makeEditable(e: MouseEvent) {
    e.stopPropagation();
    if (editor()?.isEditable) return;

    editor()?.setEditable(true);
  }

  createEffect(
    on(element, (element) => {
      setEditor(
        () =>
          new Editor({
            element: element,
            extensions: [
              StarterKit,
              Placeholder.configure({ placeholder: merged.placeholder }),
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
      editor()?.commands.setContent(merged.content);
    }
  });

  createEffect(() => {
    editor()?.setEditable(merged.editable);
  });

  return (
    <>
      <ClientOnly
        fallback={
          <div class="w-full h-full" data-fallback>
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
          onPointerDown={merged.editableOnClick ? makeEditable : undefined}
        />
      </ClientOnly>
    </>
  );
};
