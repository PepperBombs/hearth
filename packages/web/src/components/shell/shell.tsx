import { useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router";
import { isSwitcherShortcut } from "../../lib/platform";
import { useI18n } from "../../session/preferences";
import { QuickSwitcher } from "../switcher/quick-switcher";
import { SaveBanner } from "./save-banner";
import { Sidebar } from "./sidebar";
import { SwitcherContext, type SwitcherState } from "./switcher-state";
import { TabBar } from "./tab-bar";

/**
 * The frame around every screen: sidebar on wide screens, tab bar under 760px,
 * and the quick switcher on Ctrl+K or Cmd+K. Each screen renders its own top
 * bar and content through <Page>.
 */
export function Shell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const switcher = useMemo<SwitcherState>(() => ({ open, setOpen }), [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !isSwitcherShortcut(event)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SwitcherContext value={switcher}>
      <div className="flex h-dvh overflow-hidden bg-canvas text-fg">
        <a
          href="#content"
          className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-2 focus-visible:left-2 focus-visible:z-10 focus-visible:rounded-ctl focus-visible:bg-surface focus-visible:px-3 focus-visible:py-2 focus-visible:shadow-pop"
        >
          {t("nav.skip")}
        </a>
        <Sidebar className="max-md:hidden" />
        <div className="@container/main flex min-w-0 flex-1 flex-col">
          <SaveBanner />
          <Outlet />
          <TabBar className="md:hidden" />
        </div>
        <QuickSwitcher />
      </div>
    </SwitcherContext>
  );
}
