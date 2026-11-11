/**
 * @hearth/sdk: what a mini-app's manifest is written with.
 *
 * A mini-app is one folder. Its `manifest.ts` default-exports
 * `defineApp({ ... })`, which says what the app is called, how it looks on the
 * dashboard, which settings it has and which interface strings it uses, each
 * in English and Simplified Chinese.
 *
 * This file holds types, a few lists of allowed names and one identity
 * function. It imports nothing, so a manifest costs a web bundle next to
 * nothing. The run-time check of a manifest is `manifestSchema` in
 * `@hearth/sdk/manifest-schema`, which the framework uses; mini-apps do not
 * import it.
 *
 * The design is docs/mini-app-contract.md, sections A1 and A2.
 */

/**
 * The SDK version a mini-apps repository declares it was written for (the
 * "handshake"). It is the `version` in this package's package.json; a unit
 * test fails when the two differ. While below 1.0, any breaking change to SDK
 * types, component props, token class names or the manifest schema raises the
 * minor version.
 */
export const SDK_VERSION: string = "0.1.0";

/** Text in every supported language. Content typed by users is never one of these. */
export type Localized = { en: string; zh: string };

/** What an app's ID, and therefore its folder name, must look like. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Icons an app may name. The web app draws each with the Lucide icon of the
 * same name; adding one here without drawing it there is a type error.
 */
export const APP_ICONS = [
  "bookmark",
  "box",
  "calendar",
  "chart-column",
  "chart-line",
  "clock",
  "cloud-sun",
  "credit-card",
  "file-text",
  "heart",
  "image",
  "link",
  "list-checks",
  "music",
  "notebook-text",
  "shopping-bag",
  "star",
  "trending-up",
  "users",
  "utensils",
  "wallet",
] as const;
export type AppIcon = (typeof APP_ICONS)[number];

/** Colours an app's icon may have, each backed by a `--hearth-app-*` token in the web app. */
export const APP_COLORS = ["green", "purple", "teal", "amber", "pink", "orange", "blue"] as const;
export type AppColor = (typeof APP_COLORS)[number];

/** The kinds of space an app may be added to. */
export const SPACE_KINDS = ["personal", "group"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/** Dashboard card sizes on the four-column grid: 1x1, 2x1, 1x2 and 2x2. */
export const WIDGET_SIZES = ["small", "wide", "tall", "large"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** A setting holds one value for the whole space, or one for each person in it. */
export const SETTING_SCOPES = ["space", "user"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

type Field<T, X> = { label: Localized; help?: Localized; scope: SettingScope; default: T } & X;

/**
 * One setting of an app. The settings form is generated from these.
 *
 * Defaults are filled in when settings are read and are never copied into
 * the database, so changing one needs no data migration. A list default is
 * `readonly` so that it may also be a list declared `as const`; nothing ever
 * changes a default.
 */
export type Setting =
  | Field<string, { type: "text"; maxLength?: number }>
  | Field<number, { type: "number"; min?: number; max?: number; step?: number }>
  | Field<boolean, { type: "switch" }>
  | Field<string, { type: "select"; options: Record<string, Localized> }>
  | Field<readonly string[], { type: "multi-select"; options: Record<string, Localized> }>
  | Field<readonly string[], { type: "list"; maxItems?: number; maxLength?: number }>;

/**
 * What an app says about itself.
 *
 * `S` is the settings and `M` the English interface strings; `defineApp`
 * infers both, so the plain `Manifest` (any settings, any strings) is what
 * framework code handles.
 */
export type Manifest<S = Record<string, Setting>, M = Record<string, string>> = {
  /** Equal to the folder name; matches APP_ID_PATTERN. */
  id: string;
  name: Localized;
  description: Localized;
  icon: AppIcon;
  color: AppColor;
  /** Where the app may be added. Left out, it may be added to both kinds of space. */
  spaces?: readonly SpaceKind[];
  widget: { size: WidgetSize };
  /** Keyed by the name code reads the value under. */
  settings?: S;
  /**
   * The app's interface strings, with {placeholders}. English defines the
   * keys; a key missing from `zh` is a type error.
   */
  messages?: { en: M; zh: { readonly [K in keyof M]: string } };
};

/**
 * Declares a mini-app. It returns the manifest unchanged; it exists for the
 * types, which keep every setting, option and string exactly as written.
 *
 * ```ts
 * export default defineApp({
 *   id: "grocery",
 *   name: { en: "Grocery list", zh: "购物清单" },
 *   description: { en: "A shared shopping list.", zh: "共享购物清单。" },
 *   icon: "shopping-bag",
 *   color: "green",
 *   widget: { size: "tall" },
 * });
 * ```
 */
export function defineApp<
  const S extends Record<string, Setting> = Record<never, never>,
  const M extends Record<string, string> = Record<never, never>,
>(manifest: Manifest<S, M>): Manifest<S, M> {
  return manifest;
}

/**
 * The manifest behind `A`. Today `A` is always a manifest. When the SDK gains
 * `defineServer`, an app's server joins here, so that `SettingsOf` and the
 * message types below also accept `typeof server`.
 */
type ManifestOf<A> = A;

type SettingValue<F> = F extends { type: "text" }
  ? string
  : F extends { type: "number" }
    ? number
    : F extends { type: "switch" }
      ? boolean
      : F extends { type: "select"; options: infer O }
        ? Extract<keyof O, string>
        : F extends { type: "multi-select"; options: infer O }
          ? Extract<keyof O, string>[]
          : F extends { type: "list" }
            ? string[]
            : never;

/**
 * The settings values code receives, by name. A select gives the union of
 * its option keys and a multi-select an array of them.
 */
export type SettingsOf<A> =
  ManifestOf<A> extends { settings?: infer S } ? { -readonly [K in keyof S]: SettingValue<S[K]> } : never;

/** The English strings of `A`, which define its message keys. */
type MessagesOf<A> = ManifestOf<A> extends { messages?: { en: infer M } } ? M : never;

/** The keys of an app's interface strings. */
export type MessageKey<A> = Extract<keyof MessagesOf<A>, string>;

/** The names of the {placeholders} in a string, as a union. */
type PlaceholderNames<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

/**
 * What `t` takes after the key. A string with placeholders requires a values
 * object naming each of them; a string without must not get one.
 *
 * This reads the English text as a constant. Strings kept in a sibling file
 * need `as const` there; without it only the keys are known, and the values
 * object is optional and unchecked.
 */
export type PlaceholderArgs<A, K extends MessageKey<A>> = MessagesOf<A>[K] extends infer Text extends string
  ? string extends Text
    ? [values?: Record<string, string | number>]
    : [PlaceholderNames<Text>] extends [never]
      ? []
      : [values: Record<PlaceholderNames<Text>, string | number>]
  : never;

/** The `t` function for one app: looks a string up in the reader's language and fills its placeholders. */
export type Translate<A> = <K extends MessageKey<A>>(key: K, ...values: PlaceholderArgs<A, K>) => string;
