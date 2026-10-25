import { Marked, type Tokens } from "marked";
import type { Id } from "./types";

/** The link scheme a mention uses in markdown: `[@Name](mention:<user id>)`. */
export const MENTION_SCHEME = "mention:";

/** A whole mention link. Group 1 is the escaped label, group 2 the user id. */
export const MENTION_LINK = /\[@((?:\\.|[^\\\]\n])*)\]\(mention:([^)\s]+)\)/;

const MENTION_LINKS = new RegExp(MENTION_LINK.source, "g");
const MENTION_HREF = /^mention:(\S+)$/;
// A private instance, so editor tokenizers registered elsewhere never turn links into other tokens.
const parser = new Marked();
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

/** Users mentioned in `markdown`, read from its links as `domain::mentioned_users` reads them. */
export function mentionedUsers(markdown: string): Id[] {
  const ids = new Set<Id>();
  if (!markdown.includes(MENTION_SCHEME)) return [];
  parser.walkTokens(parser.lexer(markdown), (token) => {
    const id = token.type === "link" && MENTION_HREF.exec((token as Tokens.Link).href)?.[1];
    if (id) ids.add(id.toLowerCase());
  });
  return [...ids].sort();
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
