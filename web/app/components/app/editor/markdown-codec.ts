import type { AnyExtension, JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";

type TextEncoder = (text: string, node: JSONContent, parent?: JSONContent) => string;

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
const TAG_START = /[A-Za-z/!?]/;
const ENTITY = /^&(#\d+|#x[\da-f]+|\w+);/i;
const SPECIAL = /[\\`*_~\]<&]/g;

const isSpace = (c: string | undefined) => c !== undefined && SPACE.test(c);
const isWord = (c: string | undefined) => c !== undefined && WORD.test(c);

/**
 * Whether `c` at `i` would read as markdown or HTML if left alone. Stricter than escaping every
 * special character, so `snake_case`, `2 * 3` and `R&D` stay as typed in the stored text.
 */
function needsEscape(text: string, c: string, i: number) {
  const prev = text[i - 1];
  const next = text[i + 1];
  switch (c) {
    case "\\":
      return next !== undefined && PUNCTUATION.test(next);
    case "*":
    case "~":
      return !(isSpace(prev) && isSpace(next));
    case "_":
      return !(isSpace(prev) && isSpace(next)) && !(isWord(prev) && isWord(next));
    case "]":
      return next === "(" || next === "[" || next === ":";
    case "<":
      return next !== undefined && TAG_START.test(next);
    case "&":
      return ENTITY.test(text.slice(i));
    default:
      return true;
  }
}

function escapeText(text: string) {
  return text.replace(SPECIAL, (c, i: number) => {
    if (!needsEscape(text, c, i)) return c;
    if (c === "<") return "&lt;";
    if (c === "&") return "&amp;";
    return `\\${c}`;
  });
}

const inCode = (node: JSONContent, parent?: JSONContent) =>
  parent?.type === "codeBlock" ||
  (node.marks ?? []).some((m) => (typeof m === "string" ? m : m.type) === "code");

export interface MarkdownCodec {
  parse: (markdown: string) => JSONContent;
  serialize: (doc: JSONContent) => string;
}

/** Markdown in and out for an editor built from `extensions`. */
export function markdownCodec(extensions: AnyExtension[]): MarkdownCodec {
  const manager = new MarkdownManager({ extensions });
  // The stock encoder escapes every `_`, `*` and `&`, which makes stored text noisy for people
  // and agents reading it through the API.
  const internals = manager as unknown as { encodeTextForMarkdown: TextEncoder };
  internals.encodeTextForMarkdown = (text, node, parent) =>
    inCode(node, parent) ? text : escapeText(text);
  return {
    // Blank markdown parses to a doc with no blocks, which leaves the placeholder nowhere to show.
    parse: (markdown) => {
      const doc = manager.parse(markdown);
      return doc.content?.length ? doc : { type: "doc", content: [{ type: "paragraph" }] };
    },
    serialize: (doc) => manager.serialize(doc).replace(/^\n+|\s+$/g, ""),
  };
}
