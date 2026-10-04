import { createInstance, type ParseKeys } from "i18next";
import { en } from "../locales/en";
import { pl } from "../locales/pl";
import type { Language } from "./types";

// Flat, dotted keys are identifiers, not nested paths or namespaces.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    keySeparator: false;
    nsSeparator: false;
    returnNull: false;
    strictKeyChecks: true;
    resources: { translation: typeof en };
  }
}

export type Key = ParseKeys<"translation">;

/** Validate translation identifiers derived from server data. */
export function isTranslationKey(key: string): key is Key {
  return Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
}

/** Each React root owns its instance; prerendering must not share mutable locale state. */
export function createI18n(language: Language) {
  const instance = createInstance();
  void instance.init({
    lng: language,
    supportedLngs: ["en", "pl"],
    fallbackLng: "en",
    defaultNS: "translation",
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    // Both catalogs ship with the app, so translations are ready on the first render.
    initAsync: false,
    resources: { en: { translation: en }, pl: { translation: pl } },
    interpolation: { escapeValue: false }, // React escapes rendered text.
    react: { useSuspense: false },
  });
  return instance;
}
