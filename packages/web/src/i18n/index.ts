/**
 * Interface strings in English and Simplified Chinese.
 *
 * - `en.ts` defines the keys. `zh.ts` is typed as the same set, so a missing
 *   or misspelt key is a TypeScript error.
 * - `translate(locale, key, values)` looks a string up and fills its
 *   {placeholders}. The placeholders a key needs are part of its type.
 * - Content typed by people is never passed through here.
 */
import type { Locale, Localized } from "@hearth/shared";
import { en } from "./en";
import { zh } from "./zh";

export type MessageKey = keyof typeof en;
export type Dictionary = Readonly<Record<MessageKey, string>>;

export const dictionaries: Readonly<Record<Locale, Dictionary>> = { en, zh };

/** The names of the {placeholders} in a string, as a union. */
type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

/** Keys whose text has no placeholders. Use this type when the key is chosen at run time. */
export type PlainMessageKey = {
  [K in MessageKey]: [PlaceholderNames<(typeof en)[K]>] extends [never] ? K : never;
}[MessageKey];

export type MessageValues<K extends MessageKey> = Record<PlaceholderNames<(typeof en)[K]>, string | number>;

/** Keys with placeholders require a values object; keys without must not get one. */
export type TranslateArgs<K extends MessageKey> = [PlaceholderNames<(typeof en)[K]>] extends [never]
  ? []
  : [values: MessageValues<K>];

export type Translate = <K extends MessageKey>(key: K, ...args: TranslateArgs<K>) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/** The placeholder names used in a string, in order of appearance. */
export function placeholdersOf(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER), (match) => match[1] ?? "");
}

export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: TranslateArgs<K>): string {
  const text = dictionaries[locale][key];
  const values = args[0] as Record<string, string | number> | undefined;
  if (!values) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** A `t` function bound to one language. */
export function createTranslator(locale: Locale): Translate {
  return (key, ...args) => translate(locale, key, ...args);
}

/** Picks the right language from text an app supplies in both, such as its name. */
export function pickLocalized(text: Localized, locale: Locale): string {
  return text[locale] || text.en || text.zh;
}
