/** Where the interface language comes from before and after the session loads. */
import { LOCALES, type Locale } from "@hearth/shared";

export const LOCALE_STORAGE_KEY = "hearth.locale";

/** The value for <html lang>. */
export const HTML_LANG: Readonly<Record<Locale, string>> = { en: "en", zh: "zh-Hans" };

/** The other language's own name, used on the switch that changes to it. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: "English", zh: "中文" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Chinese for any Chinese browser language, English for everything else. */
export function localeFromLanguages(languages: readonly string[]): Locale {
  const first = languages[0] ?? "en";
  return /^zh\b/i.test(first) ? "zh" : "en";
}

export function readStoredLocale(storage: Pick<Storage, "getItem"> | undefined): Locale | null {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(storage: Pick<Storage, "setItem"> | undefined, locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* Storage can be blocked; the choice then lasts for this visit only. */
  }
}

/** The language to show before the session has loaded. */
export function initialLocale(storage: Pick<Storage, "getItem"> | undefined, languages: readonly string[]): Locale {
  return readStoredLocale(storage) ?? localeFromLanguages(languages);
}

export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "zh" : "en";
}

export function applyLocale(doc: Document, locale: Locale): void {
  doc.documentElement.lang = HTML_LANG[locale];
}
