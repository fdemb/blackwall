import { Marked, Tokenizer, type Tokens } from "marked";
import type { Id } from "./types";

/** The link scheme a mention uses in markdown: `[@Name](mention:<user id>)`. */
export const MENTION_SCHEME = "mention:";

/** A whole mention link. Group 1 is the escaped label, group 2 the user id. */
export const MENTION_LINK = /\[@((?:\\.|[^\\\]\n])*)\]\(mention:([^)\s]+)\)/;

const MENTION_LINKS = new RegExp(MENTION_LINK.source, "g");
const MENTION_HREF =
  /^mention:([\dA-Fa-f]{8}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{4}-[\dA-Fa-f]{12})$/;
// pulldown-cmark on the server decodes escapes and character references in link destinations in
// one pass. marked drops the escapes and keeps the references. `&colon;` is the only named
// reference that spells a character a mention holds.
const DESTINATION_ESCAPE = /\\([!-/:-@[-`{-~])|&(?:#(\d{1,7})|#[xX]([\dA-Fa-f]{1,6})|colon);/g;
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const NOTHING = /(?!)/g;

/** `tokenizer` with marked's escape removal off, so destinations come out as written. */
function keepEscapes(tokenizer: Tokenizer): Tokenizer {
  const inline = { ...tokenizer.rules.inline, anyPunctuation: NOTHING };
  return Object.assign(Object.create(tokenizer) as Tokenizer, {
    rules: { ...tokenizer.rules, inline },
  });
}

// A private instance, so editor tokenizers registered elsewhere never turn links into other tokens.
const parser = new Marked({
  tokenizer: {
    link(src) {
      return Tokenizer.prototype.link.call(keepEscapes(this), src);
    },
    def(src) {
      return Tokenizer.prototype.def.call(keepEscapes(this), src);
    },
  },
});

/** Users mentioned in `markdown`, read from its links as `domain::mentioned_users` reads them. */
export function mentionedUsers(markdown: string): Id[] {
  const ids = new Set<Id>();
  // References and escapes can spell the colon, so look for the bare word.
  if (!markdown.includes("mention")) return [];
  parser.walkTokens(parser.lexer(markdown), (token) => {
    if (token.type !== "link") return;
    const link = token as Tokens.Link;
    // Autolinks keep escapes and references as written.
    const href = link.raw.startsWith("<") ? link.href : decodeDestination(link.href);
    const id = MENTION_HREF.exec(href)?.[1];
    if (id) ids.add(id.toLowerCase());
  });
  return [...ids].sort();
}

function decodeDestination(text: string): string {
  return text.replace(DESTINATION_ESCAPE, (_, escaped?: string, decimal?: string, hex?: string) => {
    if (escaped !== undefined) return escaped;
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
