import { Node } from "@tiptap/core";
import { MENTION_LINK, MENTION_SCHEME, unescapeLabel } from "~/lib/mentions";

const LINK = new RegExp(`^${MENTION_LINK.source}`);
const LABEL_SPECIAL = /[\\[\]*_`<~]/g;

/**
 * A person, stored as the markdown link `[@Name](mention:<user id>)`. The server reads the id to
 * alert them, so a rename or a similar name never changes who was mentioned.
 */
export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      id: { default: null, rendered: false },
      label: { default: "", rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-mention]",
        getAttrs: (element) => ({
          id: element.getAttribute("data-mention"),
          label: element.textContent?.replace(/^@/, "") ?? "",
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return ["span", { class: "mention", "data-mention": node.attrs.id }, `@${node.attrs.label}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label}`;
  },

  markdownTokenizer: {
    name: "mention",
    level: "inline",
    start: (src) => src.indexOf("[@"),
    tokenize: (src) => {
      const match = LINK.exec(src);
      if (!match) return undefined;
      return {
        type: "mention",
        raw: match[0],
        id: match[2].toLowerCase(),
        label: unescapeLabel(match[1]),
      };
    },
  },

  parseMarkdown: (token) => ({ type: "mention", attrs: { id: token.id, label: token.label } }),

  renderMarkdown: (node) =>
    `[@${String(node.attrs?.label ?? "").replace(LABEL_SPECIAL, "\\$&")}](${MENTION_SCHEME}${node.attrs?.id})`,
});
