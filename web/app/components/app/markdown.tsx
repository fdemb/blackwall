import { useEffect, useState } from "react";
import { markdown } from "~/lib/api";
import { cn } from "~/lib/utils";
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
  return <div className={cn("typeset", className)} dangerouslySetInnerHTML={{ __html: html }} />;
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
