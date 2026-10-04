import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { useLocale } from "react-aria-components";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import { en } from "../locales/en";
import { pl } from "../locales/pl";
import { createI18n, isTranslationKey } from "./i18n-instance";
import { I18nProvider, initialLanguage, LANG_KEY, useI18n } from "./i18n";

const bootstrap = readFileSync(new URL("../../public/theme.js", import.meta.url), "utf8");

function installBrowser(saved: string | null, browserLanguage = "en-US") {
  const localStorage = { getItem: vi.fn(() => saved), setItem: vi.fn() };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("navigator", { language: browserLanguage });
  return localStorage;
}

afterEach(() => vi.unstubAllGlobals());

describe("i18next catalogs", () => {
  it("initializes bundled translations synchronously and keeps instances independent", async () => {
    const english = createI18n("en");
    const polish = createI18n("pl");
    expect(english.isInitialized).toBe(true);
    expect(polish.isInitialized).toBe(true);
    expect(english.t("action.save")).toBe("Save");
    expect(polish.t("action.save")).toBe("Zapisz");
    await english.changeLanguage("pl");
    expect(english.t("action.save")).toBe("Zapisz");
    await english.changeLanguage("en");
    expect(polish.resolvedLanguage).toBe("pl");
    expect(polish.t("action.save")).toBe("Zapisz");
  });

  it.each([
    [0, "0 issues", "0 people"],
    [1, "1 issue", "1 person"],
    [2, "2 issues", "2 people"],
  ])("selects English plurals for %s", (count, issues, members) => {
    const instance = createI18n("en");
    expect(instance.t("count.issues", { count })).toBe(issues);
    expect(instance.t("count.members", { count })).toBe(members);
  });

  it.each([
    [0, "0 zadań", "0 osób"],
    [1, "1 zadanie", "1 osoba"],
    [2, "2 zadania", "2 osoby"],
    [5, "5 zadań", "5 osób"],
    [12, "12 zadań", "12 osób"],
    [21, "21 zadań", "21 osób"],
    [22, "22 zadania", "22 osoby"],
    [25, "25 zadań", "25 osób"],
    [1.5, "1.5 zadania", "1.5 osoby"],
  ])("selects Polish plurals for %s", (count, issues, members) => {
    const instance = createI18n("pl");
    expect(instance.t("count.issues", { count })).toBe(issues);
    expect(instance.t("count.members", { count })).toBe(members);
  });

  it("interpolates values without escaping React text twice", () => {
    const instance = createI18n("en");
    const name = "<b>A&B</b>";
    expect(instance.t("welcome.title", { name })).toBe(`Welcome, ${name}`);
    expect(instance.t("sprint.progress", { done: 1, total: 5 })).toBe("1 of 5 done");
    expect(instance.t("issue.titleHeading", { key: "BW-1", title: "Fix" })).toBe("Issue BW-1: Fix");
    expectTypeOf(instance.t("action.save")).toExtend<string>();
    expect(renderToStaticMarkup(<span>{instance.t("welcome.title", { name })}</span>)).toBe(
      "<span>Welcome, &lt;b&gt;A&amp;B&lt;/b&gt;</span>",
    );
  });

  it("falls back to English when the target catalog is unavailable", () => {
    const instance = createI18n("pl");
    instance.removeResourceBundle("pl", "translation");
    expect(instance.t("error.title")).toBe("Something went wrong");
    expect(instance.t("count.issues", { count: 1 })).toBe("1 issue");
  });

  it("validates dynamic identifiers rather than casting server actions to keys", () => {
    expect(isTranslationKey("activity.create_issue")).toBe(true);
    expect(isTranslationKey("count.issues")).toBe(true);
    expect(isTranslationKey("activity.unknown_action")).toBe(false);
    expect(isTranslationKey("toString")).toBe(false);
  });

  it("keeps interpolation variables consistent across catalogs", () => {
    const variables = (text: string) =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const polish = createI18n("pl");
    for (const [key, text] of Object.entries(en)) {
      const translated: unknown = polish.getResource("pl", "translation", key);
      expect(typeof translated, key).toBe("string");
      if (typeof translated !== "string") throw new Error(`Missing Polish translation: ${key}`);
      expect(variables(translated), key).toEqual(variables(text));
    }
    for (const catalog of [en, pl]) {
      for (const [key, text] of Object.entries(catalog)) {
        expect(text, key).not.toMatch(/(?<!\{)\{\w+\}(?!\})/);
      }
    }
    for (const [key, text] of Object.entries(pl)) {
      const englishKey = key.replace(/_(few|many)$/, "_other");
      const english: unknown = polish.getResource("en", "translation", englishKey);
      if (typeof english !== "string")
        throw new Error(`Missing English translation: ${englishKey}`);
      expect(variables(text), key).toEqual(variables(english));
    }
  });
});

describe("app locale", () => {
  it("uses the stored preference before the browser language", () => {
    installBrowser("en", "pl-PL");
    expect(initialLanguage()).toBe("en");
    installBrowser("pl", "en-US");
    expect(initialLanguage()).toBe("pl");
  });

  it("ignores invalid preferences and detects Polish browsers", () => {
    installBrowser("de", "pl-PL");
    expect(initialLanguage()).toBe("pl");
    installBrowser(null, "de-DE");
    expect(initialLanguage()).toBe("en");
  });

  it("works when storage is blocked or the browser is unavailable", () => {
    const storage = installBrowser(null, "pl-PL");
    storage.getItem.mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    expect(initialLanguage()).toBe("pl");
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    expect(initialLanguage()).toBe("en");
  });

  it.each(["en", "pl"] as const)("shares the initial %s locale with React Aria", (initial) => {
    function Probe() {
      const { t, lang } = useI18n();
      const { locale } = useLocale();
      return (
        <span data-lang={lang} data-aria-locale={locale}>
          {t("action.save")}
        </span>
      );
    }
    const markup = renderToStaticMarkup(
      <I18nProvider initial={initial}>
        <Probe />
      </I18nProvider>,
    );
    expect(markup).toContain(`data-lang="${initial}" data-aria-locale="${initial}"`);
    expect(markup).toContain(initial === "pl" ? "Zapisz" : "Save");
  });

  it("reads the same versioned preference before first paint", () => {
    const localStorage = installBrowser("pl", "en-US");
    const document = { documentElement: { lang: "en", classList: { toggle: vi.fn() } } };
    runInNewContext(bootstrap, {
      localStorage,
      navigator: { language: "en-US" },
      document,
      matchMedia: () => ({ matches: false }),
    });
    expect(document.documentElement.lang).toBe(initialLanguage());
    expect(localStorage.getItem).toHaveBeenCalledWith(LANG_KEY);
  });
});
