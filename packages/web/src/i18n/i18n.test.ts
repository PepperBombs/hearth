import { describe, expect, expectTypeOf, it } from "vitest";
import { LOCALES } from "@hearth/shared";
import {
  createTranslator,
  dictionaries,
  joinNames,
  pickLocalized,
  placeholdersOf,
  translate,
  type MessageKey,
  type PlainMessageKey,
} from "./index";
import {
  HTML_LANG,
  LOCALE_STORAGE_KEY,
  applyLocale,
  initialLocale,
  isLocale,
  localeFromLanguages,
  otherLocale,
  readStoredLocale,
  storeLocale,
} from "./locale";

const keys = Object.keys(dictionaries.en) as MessageKey[];

describe("dictionaries", () => {
  it("has the same keys in every language", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(dictionaries[locale]).sort()).toEqual([...keys].sort());
    }
  });

  it("has no empty strings", () => {
    for (const locale of LOCALES) {
      for (const key of keys) expect(dictionaries[locale][key].trim(), `${locale} ${key}`).not.toBe("");
    }
  });

  it("uses the same placeholders in every language", () => {
    for (const key of keys) {
      const expected = placeholdersOf(dictionaries.en[key]).sort();
      expect(placeholdersOf(dictionaries.zh[key]).sort(), key).toEqual(expected);
    }
  });

  it("marks at most one link, in [brackets], and the same in every language", () => {
    // LinkedText (src/components/linked-text.tsx) draws the bracketed words as a link.
    const marks = (text: string) => (text.match(/[[\]]/g) ?? []).join("");
    for (const key of keys) {
      const expected = marks(dictionaries.en[key]);
      expect(["", "[]"], key).toContain(expected);
      expect(marks(dictionaries.zh[key]), key).toBe(expected);
    }
  });

  it("actually translates: Chinese text contains Chinese", () => {
    // A few strings are the same in both languages by design (symbols only); none are today.
    for (const key of keys) expect(dictionaries.zh[key], key).toMatch(/[一-鿿]/);
  });
});

describe("translate", () => {
  it("returns the string for the language", () => {
    expect(translate("en", "nav.dashboard")).toBe("Dashboard");
    expect(translate("zh", "nav.dashboard")).toBe("仪表盘");
  });

  it("fills placeholders", () => {
    expect(translate("en", "error.details", { code: "internal" })).toBe("Details: internal");
    expect(translate("zh", "error.details", { code: 42 })).toBe("详细信息：42");
  });

  it("leaves a placeholder in place when its value is missing at run time", () => {
    const loose = translate as (locale: "en", key: MessageKey, values: Record<string, string>) => string;
    expect(loose("en", "error.details", {})).toBe("Details: {code}");
  });

  it("binds a language with createTranslator", () => {
    const t = createTranslator("zh");
    expect(t("nav.settings")).toBe("设置");
    expect(t("error.details", { code: "x" })).toBe("详细信息：x");
  });

  it("rejects unknown keys and wrong placeholders at compile time", () => {
    const t = createTranslator("en");
    // @ts-expect-error not a key
    t("nav.nope");
    // @ts-expect-error this key needs { code }
    t("error.details");
    // @ts-expect-error wrong placeholder name
    t("error.details", { reason: "x" });
    // @ts-expect-error this key takes no values
    t("nav.dashboard", { code: "x" });
    expectTypeOf<"error.details">().not.toMatchTypeOf<PlainMessageKey>();
    expectTypeOf<"nav.dashboard">().toMatchTypeOf<PlainMessageKey>();
  });
});

describe("pickLocalized", () => {
  it("picks the language, falling back to the other when one is empty", () => {
    expect(pickLocalized({ en: "Grocery", zh: "购物清单" }, "zh")).toBe("购物清单");
    expect(pickLocalized({ en: "Grocery", zh: "" }, "zh")).toBe("Grocery");
    expect(pickLocalized({ en: "", zh: "购物清单" }, "en")).toBe("购物清单");
  });
});

describe("joinNames", () => {
  it("joins names as each language lists them", () => {
    expect(joinNames(["api.github.com", "feeds.example.com", "photos.example.net"], "en")).toBe(
      "api.github.com, feeds.example.com, photos.example.net",
    );
    expect(joinNames(["api.github.com", "feeds.example.com"], "zh")).toBe("api.github.com、feeds.example.com");
    expect(joinNames(["api.github.com"], "zh")).toBe("api.github.com");
    expect(joinNames([], "en")).toBe("");
  });
});

describe("locale helpers", () => {
  it("recognises supported languages only", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("maps browser languages to Chinese or English", () => {
    expect(localeFromLanguages(["zh-CN", "en"])).toBe("zh");
    expect(localeFromLanguages(["zh-Hant-TW"])).toBe("zh");
    expect(localeFromLanguages(["en-GB", "zh"])).toBe("en");
    expect(localeFromLanguages(["de"])).toBe("en");
    expect(localeFromLanguages([])).toBe("en");
  });

  it("remembers the choice in storage and prefers it over the browser language", () => {
    expect(readStoredLocale(window.localStorage)).toBeNull();
    expect(initialLocale(window.localStorage, ["zh-CN"])).toBe("zh");
    storeLocale(window.localStorage, "en");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(initialLocale(window.localStorage, ["zh-CN"])).toBe("en");
  });

  it("ignores junk in storage and survives blocked storage", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "klingon");
    expect(readStoredLocale(window.localStorage)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredLocale(blocked)).toBeNull();
    expect(() => storeLocale(blocked, "zh")).not.toThrow();
    expect(readStoredLocale(undefined)).toBeNull();
  });

  it("switches to the other language", () => {
    expect(otherLocale("en")).toBe("zh");
    expect(otherLocale("zh")).toBe("en");
  });

  it("sets the html lang attribute", () => {
    applyLocale(document, "zh");
    expect(document.documentElement.lang).toBe(HTML_LANG.zh);
    expect(document.documentElement.lang).toBe("zh-Hans");
    applyLocale(document, "en");
    expect(document.documentElement.lang).toBe("en");
  });
});
