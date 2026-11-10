import { Globe, House, Moon, Search, SlidersHorizontal, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import type { AppSummary } from "@hearth/shared";
import { pickLocalized } from "../../i18n";
import { HTML_LANG, LOCALE_NAMES, otherLocale } from "../../i18n/locale";
import { cx } from "../../lib/cx";
import { switcherShortcut } from "../../lib/platform";
import { usePreferences } from "../../session/preferences";
import { appPath, spacesWithApps, useSession } from "../../session/session";
import { AppIcon, BrandMark } from "../app-icon";
import { useSwitcher } from "./switcher-state";

const NAV_ITEM =
  "flex h-[var(--hearth-row)] w-full flex-none items-center gap-2 rounded-ctl px-2 text-left text-fg-2 hover:bg-hover hover:text-fg " +
  "aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium aria-[current=page]:text-accent-fg " +
  "aria-[current=page]:shadow-[inset_3px_0_0_var(--hearth-accent)]";

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="px-2 pt-3 pb-1 text-xs font-medium text-fg-3">{children}</h2>;
}

function AppLinks({ apps }: { apps: AppSummary[] }) {
  const { locale, t } = usePreferences();
  const withPages = apps.filter((app) => app.hasPage);
  if (withPages.length === 0) return <p className="px-2 py-1 text-xs text-fg-3">{t("nav.noApps")}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {withPages.map((app) => (
        <li key={`${app.spaceId}/${app.id}`}>
          <NavLink to={appPath(app)} className={NAV_ITEM}>
            <AppIcon icon={app.icon} color={app.color} />
            <span className="clip">{pickLocalized(app.name, locale)}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** The desktop navigation. On phones the tab bar takes its place. */
export function Sidebar({ className }: { className?: string }) {
  const session = useSession();
  const { locale, t, resolvedTheme, toggleTheme, toggleLocale } = usePreferences();
  const switcher = useSwitcher();
  const { personal, groups } = spacesWithApps(session);
  const nextLocale = otherLocale(locale);

  return (
    <nav
      aria-label={t("nav.main")}
      className={cx(
        "flex w-64 flex-none flex-col gap-1 border-r border-line bg-side p-3 pl-[max(12px,env(safe-area-inset-left))]",
        className,
      )}
    >
      <div className="flex h-10 flex-none items-center gap-2 px-2 text-md font-semibold">
        <BrandMark className="text-accent" />
        <span>Hearth</span>
      </div>

      <button
        type="button"
        onClick={() => switcher.setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className="mt-1 mb-2 flex h-[34px] w-full flex-none items-center gap-2 rounded-ctl border border-line bg-surface px-2 text-left text-fg-3"
      >
        <Search size={16} aria-hidden="true" />
        <span className="clip">{t("nav.search")}</span>
        <kbd className="ml-auto flex-none rounded-kbd border border-line bg-surface-2 px-[5px] font-sans text-2xs text-fg-3">
          {switcherShortcut()}
        </kbd>
      </button>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
        <NavLink to="/" end className={NAV_ITEM}>
          <House size={16} aria-hidden="true" />
          <span className="clip">{t("nav.dashboard")}</span>
        </NavLink>

        <section aria-label={t("nav.personal")}>
          <SectionLabel>{t("nav.personal")}</SectionLabel>
          <AppLinks apps={personal} />
        </section>

        {groups.map(({ space, apps }) => (
          <section key={space.id} aria-label={space.name}>
            <SectionLabel>{space.name}</SectionLabel>
            <AppLinks apps={apps} />
          </section>
        ))}
      </div>

      <div className="flex flex-none flex-col gap-1 pt-1">
        <NavLink to="/settings" className={NAV_ITEM}>
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span className="clip">{t("nav.settings")}</span>
        </NavLink>
        <button type="button" onClick={toggleTheme} className={NAV_ITEM}>
          {resolvedTheme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          <span className="clip">{resolvedTheme === "dark" ? t("nav.lightMode") : t("nav.darkMode")}</span>
        </button>
        <button type="button" onClick={toggleLocale} className={NAV_ITEM}>
          <Globe size={16} aria-hidden="true" />
          <span className="sr-only">{t("nav.switchLanguage")}: </span>
          <span lang={HTML_LANG[nextLocale]}>{LOCALE_NAMES[nextLocale]}</span>
        </button>
      </div>
    </nav>
  );
}
