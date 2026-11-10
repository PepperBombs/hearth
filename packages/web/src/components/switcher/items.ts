/** What the quick switcher can find: pages, the person's apps, and a few actions. */
import type { Locale, Session } from "@hearth/shared";
import { dictionaries, pickLocalized, type PlainMessageKey, type Translate } from "../../i18n";
import { LOCALE_NAMES, otherLocale } from "../../i18n/locale";
import { appPath, enabledApps } from "../../session/session";
import type { ResolvedTheme } from "../../theme/theme";

export type SwitcherGroup = "pages" | "apps" | "actions";

export type SwitcherTarget =
  | { kind: "navigate"; to: string }
  | { kind: "toggle-theme" }
  | { kind: "system-theme" }
  | { kind: "toggle-locale" };

export type SwitcherItem = {
  /** Unique within the list. */
  id: string;
  group: SwitcherGroup;
  label: string;
  /** Language of the label when it is not the page's language. */
  labelLang?: Locale;
  /** The small note on the right: what choosing the item does, or where it lives. */
  note: string;
  /** Extra words that find the item, in both languages. */
  keywords: string[];
  target: SwitcherTarget;
  /** Set for apps, to draw their icon. */
  app?: { icon: string; color: string };
};

/** A string in both languages, so an item is found whichever language is typed. */
function both(key: PlainMessageKey): string[] {
  return [dictionaries.en[key], dictionaries.zh[key]];
}

export function buildSwitcherItems(options: {
  session: Session;
  locale: Locale;
  resolvedTheme: ResolvedTheme;
  t: Translate;
}): SwitcherItem[] {
  const { session, locale, resolvedTheme, t } = options;
  const spaceName = (spaceId: string): string => {
    const space = session.spaces.find((candidate) => candidate.id === spaceId);
    return !space || space.kind === "personal" ? t("nav.personal") : space.name;
  };

  const pages: SwitcherItem[] = [
    {
      id: "page:dashboard",
      group: "pages",
      label: t("nav.dashboard"),
      note: t("switcher.openPage"),
      keywords: [...both("nav.dashboard"), ...both("tab.home"), "主页"],
      target: { kind: "navigate", to: "/" },
    },
    {
      id: "page:apps",
      group: "pages",
      label: t("nav.apps"),
      note: t("switcher.openPage"),
      keywords: both("nav.apps"),
      target: { kind: "navigate", to: "/apps" },
    },
    {
      id: "page:settings",
      group: "pages",
      label: t("nav.settings"),
      note: t("switcher.openPage"),
      keywords: [...both("nav.settings"), ...both("tab.me"), ...both("settings.account"), "preferences", "偏好"],
      target: { kind: "navigate", to: "/settings" },
    },
  ];

  const apps: SwitcherItem[] = enabledApps(session)
    .filter((app) => app.hasPage)
    .map((app) => ({
      id: `app:${app.spaceId}/${app.id}`,
      group: "apps",
      label: pickLocalized(app.name, locale),
      note: spaceName(app.spaceId),
      keywords: [app.name.en, app.name.zh, app.description.en, app.description.zh, spaceName(app.spaceId)],
      target: { kind: "navigate", to: appPath(app) },
      app: { icon: app.icon, color: app.color },
    }));

  const nextLocale = otherLocale(locale);
  const themeWords = [...both("settings.theme"), ...both("settings.appearance"), ...both("nav.darkMode"), ...both("nav.lightMode")];
  const actions: SwitcherItem[] = [
    {
      id: "action:toggle-theme",
      group: "actions",
      label: resolvedTheme === "dark" ? t("switcher.themeLight") : t("switcher.themeDark"),
      note: t("switcher.action"),
      keywords: [...themeWords, ...both("switcher.themeDark"), ...both("switcher.themeLight"), "theme dark light", "夜间"],
      target: { kind: "toggle-theme" },
    },
    {
      id: "action:system-theme",
      group: "actions",
      label: t("switcher.themeSystem"),
      note: t("switcher.action"),
      keywords: [...themeWords, ...both("switcher.themeSystem"), ...both("settings.themeSystem"), "auto", "自动"],
      target: { kind: "system-theme" },
    },
    {
      id: "action:toggle-locale",
      group: "actions",
      // Written in the language it switches to, so it can be read by someone who cannot read the current one.
      label: LOCALE_NAMES[nextLocale],
      labelLang: nextLocale,
      note: t("nav.switchLanguage"),
      keywords: [...both("nav.switchLanguage"), ...both("settings.language"), "English", "Chinese", "中文", "英文", "英语", "汉语"],
      target: { kind: "toggle-locale" },
    },
  ];

  return [...pages, ...apps, ...actions];
}
