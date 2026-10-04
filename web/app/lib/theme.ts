import type { Theme } from "./types";
import { safeGet, safeSet } from "./storage";

const KEY = "bw-theme:v1";

export function applyTheme(theme: Theme) {
  safeSet("local", KEY, theme);
  if (typeof document === "undefined" || typeof matchMedia === "undefined") return;
  const dark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function watchSystemTheme() {
  if (typeof matchMedia === "undefined") return () => {};
  const query = matchMedia("(prefers-color-scheme: dark)");
  const listener = () => {
    if ((safeGet("local", KEY) ?? "system") === "system") applyTheme("system");
  };
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
