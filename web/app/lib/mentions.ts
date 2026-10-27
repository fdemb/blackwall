import { Marked, type Tokens } from "marked";
import type { Id } from "./types";

/** The link scheme a mention uses in markdown: `[@Name](mention:<user id>)`. */
export const MENTION_SCHEME = "mention:";

/** A whole mention link. Group 1 is the escaped label, group 2 the user id. */
export const MENTION_LINK = /\[@((?:\\.|[^\\\]\n])*)\]\(mention:([^)\s]+)\)/;

const MENTION_LINKS = new RegExp(MENTION_LINK.source, "g");
const MENTION_HREF =
  /^mention:([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})$/;
// marked keeps character references in link destinations, while pulldown-cmark on the server
// decodes them. `&colon;` is the only named reference that spells a character a mention holds.
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([\dA-Fa-f]{1,6})|colon);/g;
// A private instance, so editor tokenizers registered elsewhere never turn links into other tokens.
const parser = new Marked();
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

/** Users mentioned in `markdown`, read from its links as `domain::mentioned_users` reads them. */
export function mentionedUsers(markdown: string): Id[] {
  const ids = new Set<Id>();
  // References and escapes can spell the colon, so look for the bare word.
  if (!markdown.includes("mention")) return [];
  parser.walkTokens(parser.lexer(markdown), (token) => {
    const href = token.type === "link" && decodeReferences((token as Tokens.Link).href);
    const id = href && MENTION_HREF.exec(href)?.[1];
    if (id) ids.add(id.toLowerCase());
  });
  return [...ids].sort();
}

function decodeReferences(text: string): string {
  return text.replace(CHARACTER_REFERENCE, (_, decimal?: string, hex?: string) => {
    if (decimal === undefined && hex === undefined) return ":";
    const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
  });
}

/** Users `after` mentions that `before` did not. */
export function newMentions(after: string, before: string): Id[] {
  if (after === before) return [];
  const old = new Set(mentionedUsers(before));
  return mentionedUsers(after).filter((user) => !old.has(user));
}

export function unescapeLabel(label: string): string {
  return label.replace(ESCAPED, "$1");
}

/** `text` with each mention link written as `@Name`, for places that show markdown as text. */
export function plainMentions(text: string): string {
  return text.replace(MENTION_LINKS, (_, label: string) => `@${unescapeLabel(label)}`);
}
