import { House, LayoutGrid, Search, UserRound } from "lucide-react";
import { Link, NavLink, useMatch } from "react-router";
import { cx } from "../../lib/cx";
import { useI18n } from "../../session/preferences";
import { useSwitcher } from "./switcher-state";

/** Each tab fills a quarter of the bar and is at least 44px tall. */
const TAB =
  "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-2xs text-fg-3 " +
  "aria-[current=page]:font-semibold aria-[current=page]:text-accent-fg aria-expanded:font-semibold aria-expanded:text-accent-fg";

/**
 * The phone navigation: Home, Apps, Search, Me. Search opens the quick
 * switcher rather than a page. The app center has no tab of its own: it is
 * reached from the Apps page, and Apps stays lit while it is open.
 */
export function TabBar({ className }: { className?: string }) {
  const { t } = useI18n();
  const switcher = useSwitcher();
  const inApps = useMatch({ path: "/apps", end: false }) !== null;
  const inCenter = useMatch({ path: "/center", end: false }) !== null;
  return (
    <nav
      aria-label={t("nav.tabs")}
      className={cx(
        "flex flex-none border-t border-line bg-surface",
        "h-[calc(60px+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]",
        "pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
        className,
      )}
    >
      <NavLink to="/" end className={TAB}>
        <House size={20} aria-hidden="true" />
        <span>{t("tab.home")}</span>
      </NavLink>
      <Link to="/apps" className={TAB} aria-current={inApps || inCenter ? "page" : undefined}>
        <LayoutGrid size={20} aria-hidden="true" />
        <span>{t("tab.apps")}</span>
      </Link>
      <button
        type="button"
        className={TAB}
        aria-haspopup="dialog"
        aria-expanded={switcher.open}
        onClick={() => switcher.setOpen(true)}
      >
        <Search size={20} aria-hidden="true" />
        <span>{t("tab.search")}</span>
      </button>
      <NavLink to="/settings" className={TAB}>
        <UserRound size={20} aria-hidden="true" />
        <span>{t("tab.me")}</span>
      </NavLink>
    </nav>
  );
}
