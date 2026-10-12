import { useEffect, useRef, useState } from "react";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { Tip } from "~/components/ui/tooltip";
import { Avatar } from "~/components/ui/avatar";
import { markdown } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import { AtSign, Bold, Code, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import type { Id } from "~/lib/types";

const CACHE_LIMIT = 100;
const cache = new Map<string, string>();
/** In-flight renders, so concurrent mounts for the same text share one request. */
const inflight = new Map<string, Promise<string>>();

function cacheSet(key: string, html: string) {
  cache.delete(key);
  cache.set(key, html);
  // Oldest first: evict until back under the cap, so long sessions can't grow without bound.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function renderMarkdown(text: string): Promise<string> {
  const hit = inflight.get(text);
  if (hit) return hit;
  const task = markdown(text).then(
    (h) => {
      inflight.delete(text);
      cacheSet(text, h);
      return h;
    },
    (e) => {
      inflight.delete(text);
      throw e;
    },
  );
  inflight.set(text, task);
  return task;
}

export function Markdown({
  text,
  className,
  empty,
}: {
  text: string;
  className?: string;
  empty?: string;
}) {
  const html = useRenderedMarkdown(text);
  if (!text.trim()) return empty ? <p className="text-muted-foreground">{empty}</p> : null;
  if (html === null)
    return <p className={cn("whitespace-pre-wrap text-[14px]", className)}>{text}</p>;
  // The backend sanitizes with ammonia before returning HTML.
  return <div className={cn("prose-bw", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Server-rendered HTML for `text`, or null until it arrives or when rendering fails. */
function useRenderedMarkdown(text: string): string | null {
  // Derived during render: the cached HTML (or "" for blank text), if we have it.
  const key = text.trim() ? text : "";
  const cached = key ? (cache.get(key) ?? null) : "";
  const [fetched, setFetched] = useState<{ key: string; html: string | null }>({
    key,
    html: null,
  });
  useEffect(() => {
    // Cache hits render directly via `cached` below; only fetch on a miss.
    if (!key || cache.get(key) !== undefined) return;
    let live = true;
    renderMarkdown(key)
      .then((h) => {
        if (live) setFetched({ key, html: h });
      })
      .catch(() => live && setFetched({ key, html: null }));
    return () => {
      live = false;
    };
  }, [key, cached]);
  return cached ?? (fetched.key === key ? fetched.html : null);
}

export function mentionsIn(text: string, members: { id: Id; display_name: string }[]) {
  return members.filter((m) => text.includes(`@${m.display_name}`)).map((m) => m.id);
}

/**
 * Mention picker composed into `MarkdownEditor` when `mentions` is set. Kept as a child piece so
 * the editor stays a composition of toolbar + menu + field instead of a boolean switch.
 */
function MentionMenu({
  onInsert,
  isDisabled,
}: {
  onInsert: (text: string) => void;
  isDisabled?: boolean;
}) {
  const { t } = useI18n();
  const { members } = useWorkspace();
  return (
    <MenuTrigger>
      <Tip label={t("editor.mention")}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("editor.mention")}
          isDisabled={isDisabled}
        >
          <AtSign aria-hidden className="size-3.5" />
        </Button>
      </Tip>
      <MenuPopover placement="bottom start">
        <Menu
          items={members}
          onAction={(id) => onInsert(`@${members.find((m) => m.id === id)?.display_name ?? ""} `)}
        >
          {(m) => (
            <MenuItem id={m.id} textValue={m.display_name}>
              <Avatar name={m.display_name} src={m.avatar_url} size={16} />
              {m.display_name}
            </MenuItem>
          )}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  minRows = 4,
  autoFocus,
  onSubmit,
  mentions = true,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  autoFocus?: boolean;
  onSubmit?: () => void;
  mentions?: boolean;
  label: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  const wrap = (before: string, after = before, fallback = "") => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = value.slice(s, e) || fallback;
    onChange(value.slice(0, s) + before + selected + after + value.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + selected.length);
    });
  };
  const linePrefix = (prefix: string | ((i: number) => string)) => {
    const el = ref.current;
    if (!el) return;
    const s = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const block = value.slice(s, el.selectionEnd || s);
    const lines = (block || "")
      .split("\n")
      .map((l, i) => (typeof prefix === "string" ? prefix : prefix(i)) + l);
    onChange(value.slice(0, s) + lines.join("\n") + value.slice(s + block.length));
    requestAnimationFrame(() => el.focus());
  };
  const insert = (text: string) => wrap(text, "", "");

  const tools = [
    { icon: Bold, label: t("editor.bold"), id: "bold" },
    { icon: Italic, label: t("editor.italic"), id: "italic" },
    { icon: Code, label: t("editor.code"), id: "code" },
    { icon: Link2, label: t("editor.link"), id: "link" },
    { icon: List, label: t("editor.list"), id: "list" },
    { icon: ListOrdered, label: t("editor.numbered"), id: "numbered" },
    { icon: Quote, label: t("editor.quote"), id: "quote" },
  ] as const;
  const runTool = (id: string) => {
    switch (id) {
      case "bold":
        return wrap("**", "**", "bold");
      case "italic":
        return wrap("_", "_", "italic");
      case "code":
        return wrap("`", "`", "code");
      case "link":
        return wrap("[", "](https://)", "link");
      case "list":
        return linePrefix("- ");
      case "numbered":
        return linePrefix((i) => `${i + 1}. `);
      case "quote":
        return linePrefix("> ");
    }
  };

  return (
    <div className="rounded-lg border border-input bg-card shadow-xs transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
        {tools.map(({ icon: Icon, label: l, id }) => (
          <Tip key={l} label={l}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={l}
              isDisabled={preview}
              onPress={() => runTool(id)}
            >
              <Icon aria-hidden className="size-3.5" />
            </Button>
          </Tip>
        ))}
        {mentions && <MentionMenu onInsert={insert} isDisabled={preview} />}
        <div className="ml-auto flex rounded-md bg-muted p-0.5 ">
          {[false, true].map((p) => (
            <button
              key={String(p)}
              type="button"
              onClick={() => setPreview(p)}
              aria-pressed={preview === p}
              className={cn(
                "rounded px-2 py-0.5 font-medium text-muted-foreground pointer-coarse:px-3 pointer-coarse:py-1.5",
                preview === p && "bg-card text-foreground shadow-xs",
              )}
            >
              {p ? t("editor.preview") : t("editor.write")}
            </button>
          ))}
        </div>
      </div>
      {preview ? (
        <div className="min-h-24 px-3 py-2.5">
          <Markdown text={value} empty={t("editor.nothing")} />
        </div>
      ) : (
        <textarea
          ref={ref}
          aria-label={label}
          autoFocus={autoFocus}
          rows={minRows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const key = e.key.toLowerCase();
            if (key === "enter" && onSubmit) onSubmit();
            else if (key === "b") wrap("**", "**", "bold");
            else if (key === "i") wrap("_", "_", "italic");
            else return;
            e.preventDefault();
          }}
          className="block w-full resize-y touch-manipulation bg-transparent px-3 py-2.5 text-[14px] leading-6 outline-none placeholder:text-muted-foreground/70"
        />
      )}
    </div>
  );
}
