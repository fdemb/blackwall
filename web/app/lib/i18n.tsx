import { useCallback, useEffect, useState, type ReactNode } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { I18nProvider as AriaLocale } from "react-aria-components";
import { createI18n } from "./i18n-instance";
import { safeGet, safeSet } from "./storage";
import type { Language } from "./types";

export { createI18n, isTranslationKey, type Key } from "./i18n-instance";
export const LANG_KEY = "bw-lang:v1";

export function I18nProvider({ initial, children }: { initial: Language; children: ReactNode }) {
  const [instance] = useState(() => createI18n(initial));
  return (
    <I18nextProvider i18n={instance}>
      <LocaleBoundary>{children}</LocaleBoundary>
    </I18nextProvider>
  );
}

function LocaleBoundary({ children }: { children: ReactNode }) {
  const { lang } = useI18n();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <AriaLocale locale={lang}>{children}</AriaLocale>;
}

/** App locale preferences around react-i18next's typed translation hook. */
export function useI18n() {
  const { t, i18n } = useTranslation();
  const setLang = useCallback(
    (next: Language) => {
      safeSet("local", LANG_KEY, next);
      void i18n.changeLanguage(next);
    },
    [i18n],
  );
  if (!i18n.isInitialized) throw new Error("I18nProvider missing");
  const lang: Language = i18n.resolvedLanguage === "pl" ? "pl" : "en";
  return { lang, setLang, t };
}

export function initialLanguage(): Language {
  const saved = safeGet("local", LANG_KEY);
  if (saved === "en" || saved === "pl") return saved;
  return typeof navigator !== "undefined" && navigator.language.startsWith("pl") ? "pl" : "en";
}
