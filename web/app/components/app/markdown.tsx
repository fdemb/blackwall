import { useEffect, useRef, useState } from "react";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { Tip } from "~/components/ui/tooltip";
import { Avatar } from "~/components/ui/avatar";
import { markdown } from "~/lib/api";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import { AtSign, Bold, Code, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";
import type { Id } from "~/lib/types";

const cache = new Map<string, string>();

export function Markdown({
  text,
  className,
  empty,
}: {
  text: string;
  className?: string;
  empty?: string;
}) {
  const [html, setHtml] = useState<string | null>(cache.get(text) ?? null);
  useEffect(() => {
    if (!text.trim()) return setHtml("");
    const hit = cache.get(text);
    if (hit !== undefined) return setHtml(hit);
    let live = true;
    markdown(text)
      .then((h) => {
        cache.set(text, h);
        if (live) setHtml(h);
      })
      .catch(() => live && setHtml(null));
    return () => {
      live = false;
    };
  }, [text]);
  if (!text.trim()) return empty ? <p className="text-muted-foreground">{empty}</p> : null;
  if (html === null)
    return <p className={cn("whitespace-pre-wrap text-[14px]", className)}>{text}</p>;
  // The backend sanitizes with ammonia before returning HTML.
  return <div className={cn("prose-bw", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function mentionsIn(text: string, members: { id: Id; display_name: string }[]) {
  return members.filter((m) => text.includes(`@${m.display_name}`)).map((m) => m.id);
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
  const t = useT();
  const { members } = useWorkspace();
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
    { icon: Bold, label: t("editor.bold"), run: () => wrap("**", "**", "bold") },
    { icon: Italic, label: t("editor.italic"), run: () => wrap("_", "_", "italic") },
    { icon: Code, label: t("editor.code"), run: () => wrap("`", "`", "code") },
    { icon: Link2, label: t("editor.link"), run: () => wrap("[", "](https://)", "link") },
    { icon: List, label: t("editor.list"), run: () => linePrefix("- ") },
    { icon: ListOrdered, label: t("editor.numbered"), run: () => linePrefix((i) => `${i + 1}. `) },
    { icon: Quote, label: t("editor.quote"), run: () => linePrefix("> ") },
  ];

  return (
    <div className="rounded-lg border border-input bg-card shadow-xs transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
        {tools.map(({ icon: Icon, label: l, run }) => (
          <Tip key={l} label={l}>
            <Button variant="ghost" size="icon" aria-label={l} isDisabled={preview} onPress={run}>
              <Icon className="size-3.5" />
            </Button>
          </Tip>
        ))}
        {mentions && (
          <MenuTrigger>
            <Tip label={t("editor.mention")}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("editor.mention")}
                isDisabled={preview}
              >
                <AtSign className="size-3.5" />
              </Button>
            </Tip>
            <MenuPopover placement="bottom start">
              <Menu
                items={members}
                onAction={(id) =>
                  insert(`@${members.find((m) => m.id === id)?.display_name ?? ""} `)
                }
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
        )}
        <div className="ml-auto flex rounded-md bg-muted p-0.5 text-xs">
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
            if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
              e.preventDefault();
              wrap("**", "**", "bold");
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
              e.preventDefault();
              wrap("_", "_", "italic");
            }
          }}
          className="block w-full resize-y bg-transparent px-3 py-2.5 text-[14px] leading-6 outline-none placeholder:text-muted-foreground/70"
        />
      )}
    </div>
  );
}
