import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en } from "~/locales/en";
import { pl } from "~/locales/pl";
import type { Language } from "./types";

export type Key = keyof typeof en;
const dictionaries: Record<Language, Record<Key, string>> = { en, pl };

interface I18n {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
}
const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Language; children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(initial);
  const setLang = useCallback((next: Language) => {
    localStorage.setItem("bw-lang", next);
    document.documentElement.lang = next;
    setLangState(next);
  }, []);
  const t = useCallback<I18n["t"]>(
    (key, vars) => {
      let text = dictionaries[lang][key] ?? en[key] ?? key;
      if (vars)
        for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
      return text;
    },
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx value={value}>{children}</Ctx>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}
export const useT = () => useI18n().t;

export function initialLanguage(): Language {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem("bw-lang");
  if (saved === "en" || saved === "pl") return saved;
  return typeof navigator !== "undefined" && navigator.language.startsWith("pl") ? "pl" : "en";
}
