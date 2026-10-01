import type { Theme } from "./types";

export function applyTheme(theme: Theme) {
  localStorage.setItem("bw-theme", theme);
  const dark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function watchSystemTheme() {
  const query = matchMedia("(prefers-color-scheme: dark)");
  const listener = () => {
    if ((localStorage.getItem("bw-theme") ?? "system") === "system") applyTheme("system");
  };
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
