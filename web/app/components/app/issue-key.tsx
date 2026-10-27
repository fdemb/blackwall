import { useMemo, useSyncExternalStore } from "react";
import type { Issue } from "~/lib/types";
import { cn } from "~/lib/utils";

/**
 * The longest key of each team in a list, padded to the most digits any key has. Team keys
 * differ in width, so each team's widest key is a candidate for the list's widest.
 */
function sizers(issues: readonly Pick<Issue, "key">[]): string[] {
  const prefixes = new Set<string>();
  let digits = 0;
  for (const { key } of issues) {
    const dash = key.lastIndexOf("-") + 1;
    prefixes.add(key.slice(0, dash));
    digits = Math.max(digits, key.length - dash);
  }
  return [...prefixes].sort().map((prefix) => prefix + "0".repeat(digits));
}

// One hidden element measures every sizer at 100px, so widths come out in em and hold at any
// font size. Results are cached until a web font finishes loading and changes the metrics.
const PROBE_SIZE = 100;
const widths = new Map<string, number>();
let probe: HTMLSpanElement | undefined;
let fontLoads = 0;
const listeners = new Set<() => void>();

function createProbe(): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("aria-hidden", "true");
  Object.assign(span.style, {
    position: "fixed",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre",
    fontSize: `${PROBE_SIZE}px`,
    fontVariantNumeric: "tabular-nums",
  });
  return document.body.appendChild(span);
}

function measure(text: string): number {
  let width = widths.get(text);
  if (width === undefined) {
    probe ??= createProbe();
    probe.textContent = text;
    width = probe.getBoundingClientRect().width / PROBE_SIZE;
    widths.set(text, width);
  }
  return width;
}

function fontsLoaded() {
  widths.clear();
  fontLoads += 1;
  for (const notify of listeners) notify();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) document.fonts?.addEventListener("loadingdone", fontsLoaded);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.fonts?.removeEventListener("loadingdone", fontsLoaded);
  };
}

/** The width every key in `issues` gets so a list's keys line up, as a CSS length. */
export function useIssueKeyWidth(issues: readonly Pick<Issue, "key">[]): string | undefined {
  const fonts = useSyncExternalStore(
    subscribe,
    () => fontLoads,
    () => -1,
  );
  const text = sizers(issues).join(" ");
  return useMemo(() => {
    if (fonts < 0 || !text) return undefined;
    return `${Math.max(...text.split(" ").map(measure))}em`;
  }, [text, fonts]);
}

export function IssueKey({
  value,
  width,
  className,
}: {
  value: string;
  /** From `useIssueKeyWidth`, so keys in one list line up. */
  width?: string;
  className?: string;
}) {
  return (
    <span
      style={width ? { minWidth: width } : undefined}
      className={cn("inline-block shrink-0 whitespace-nowrap tabular-nums", className)}
    >
      {value}
    </span>
  );
}
