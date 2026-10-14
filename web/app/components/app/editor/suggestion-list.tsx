import { useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { popoverSurface } from "~/components/ui/popover";
import type { SuggestionBridge, SuggestionSession } from "./extensions";

const STEPS: Partial<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };

/**
 * The popup for a suggestion menu. Arrow keys move, Enter or Tab picks, all while focus stays in
 * the editor. Rows keep focus there too, so a click doesn't count as leaving the editor.
 */
export function SuggestionList<T>({
  session,
  items,
  itemKey,
  renderItem,
  bridge,
  label,
  empty,
}: {
  session: SuggestionSession | null;
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  bridge: SuggestionBridge;
  label: string;
  empty: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState(session?.query);
  if (query !== session?.query) {
    setQuery(session?.query);
    setActive(0);
  }
  const mount = session?.mount;
  useLayoutEffect(() => {
    if (!mount || !ref.current) return;
    return mount(ref.current);
  }, [mount]);
  useLayoutEffect(() => {
    ref.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useLayoutEffect(() => {
    bridge.onKey((event) => {
      if (!session || items.length === 0) return false;
      const step = STEPS[event.key];
      if (step) {
        setActive((i) => (i + step + items.length) % items.length);
        return true;
      }
      if (event.key !== "Enter" && event.key !== "Tab") return false;
      const item = items[Math.min(active, items.length - 1)];
      if (item !== undefined) session.pick(item);
      return true;
    });
  });

  if (!session) return null;
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      style={{ visibility: "hidden" }}
      className={cn(popoverSurface, "z-50 max-h-72 min-w-56 max-w-72 overflow-auto p-1")}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 && <p className="px-2 py-1.5 text-muted-foreground">{empty}</p>}
      {items.map((item, i) => (
        <div
          key={itemKey(item)}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          onMouseMove={() => setActive(i)}
          onClick={() => session.pick(item)}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
            i === active && "bg-accent text-accent-foreground",
          )}
        >
          {renderItem(item)}
        </div>
      ))}
    </div>
  );
}
