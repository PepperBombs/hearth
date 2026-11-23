/**
 * @hearth/sdk: the rules an app's manifest keeps to.
 *
 * A manifest says what an app is called, how it looks on the dashboard,
 * which hosts it may fetch from and which settings it has, each text in
 * English and Simplified Chinese. Every app the server holds is described by
 * one: an app made in Hearth keeps a manifest of its own shape in the
 * database (packages/server/src/made/manifest.ts), from which the server
 * works out this one (`asSdkManifest`) and checks it, so that its settings
 * and hosts follow exactly these rules.
 *
 * This file holds types and a few lists of allowed names. It imports
 * nothing, so that the web app pays next to nothing for it. The run-time
 * check of a manifest, and of one setting's value, is
 * `@hearth/sdk/manifest-schema`.
 */

/** Text in every supported language. Content typed by users is never one of these. */
export type Localized = { en: string; zh: string };

/** What an app's ID must look like. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Icons an app may name, and that `Icon` in `@hearth/sdk/web` draws, each
 * with the Lucide icon of the same name. Adding one here without drawing it
 * there is a type error.
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
 *
 * What a setting declares is also the rule for what may be saved in it, and
 * its own default must keep to it: a text is at most `maxLength` characters;
 * a number lies from `min` to `max` and, with `step`, is `min` (0 when
 * there is none) plus a whole number of steps, so `step: 1` means whole
 * numbers; a select holds the key of one option and a multi-select a list
 * of keys, none twice; a list has at most `maxItems` texts of at most
 * `maxLength` characters each.
 *
 * A saved value that no longer fits, because the manifest changed since,
 * is read as the default; a multi-select first loses the keys that are no
 * longer options. A value saved under a name the manifest no longer has is
 * not read at all.
 */
export type Setting =
  | Field<string, { type: "text"; maxLength?: number }>
  | Field<number, { type: "number"; min?: number; max?: number; step?: number }>
  | Field<boolean, { type: "switch" }>
  | Field<string, { type: "select"; options: Record<string, Localized> }>
  | Field<readonly string[], { type: "multi-select"; options: Record<string, Localized> }>
  | Field<readonly string[], { type: "list"; maxItems?: number; maxLength?: number }>;

/** What an app says about itself. */
export type Manifest = {
  /** Matches APP_ID_PATTERN. */
  id: string;
  name: Localized;
  description: Localized;
  icon: AppIcon;
  color: AppColor;
  /**
   * The kinds of space the app is for: both when left out. An app made in
   * Hearth leaves it out, since it lives in the one space it was made in.
   */
  spaces?: readonly SpaceKind[];
  widget: { size: WidgetSize };
  /**
   * The hosts the app may fetch from, through the server, as lower-case DNS
   * names ("api.github.com"): one to ten, each written once, exactly as the
   * requests name it. Whoever adds the app is shown them. Left out, the app
   * fetches nothing. A name of the local network (`localhost`, or one ending
   * in `.localhost`, `.local`, `.internal` or `.home.arpa`) is refused.
   */
  network?: readonly string[];
  /** Keyed by the name the value is read under. */
  settings?: Record<string, Setting>;
  /**
   * Interface strings with {placeholders}, by key: the same keys in both
   * languages, and the same placeholders in both versions of a string. An
   * app made in Hearth leaves them out: its page holds its own texts.
   */
  messages?: { en: Record<string, string>; zh: Record<string, string> };
};
