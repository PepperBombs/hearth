import { Command } from "cmdk";
import { ArrowRight, Globe, Search, SunMoon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { PlainMessageKey } from "../../i18n";
import { HTML_LANG } from "../../i18n/locale";
import { useI18n, usePreferences } from "../../session/preferences";
import { useSession } from "../../session/session";
import { AppIcon } from "../app-icon";
import { useSwitcher } from "../shell/switcher-state";
import { Dialog } from "../ui";
import { buildSwitcherItems, type SwitcherGroup, type SwitcherItem } from "./items";
import { matchScore } from "./match";

const GROUPS: ReadonlyArray<{ id: SwitcherGroup; heading: PlainMessageKey }> = [
  { id: "pages", heading: "switcher.groupPages" },
  { id: "apps", heading: "switcher.groupApps" },
  { id: "actions", heading: "switcher.groupActions" },
];

/** cmdk passes the item's id as `value`; matching is done on its label and keywords instead. */
const filter = (_value: string, search: string, keywords?: string[]) => matchScore(keywords ?? [], search);

function itemIcon(item: SwitcherItem): ReactNode {
  if (item.app) return <AppIcon icon={item.app.icon} color={item.app.color} />;
  if (item.target.kind === "toggle-locale") return <Globe size={16} aria-hidden="true" className="text-fg-3" />;
  if (item.group === "actions") return <SunMoon size={16} aria-hidden="true" className="text-fg-3" />;
  return <ArrowRight size={16} aria-hidden="true" className="text-fg-3" />;
}

/**
 * The quick switcher: one box that finds pages, apps and actions in either
 * language. Opened with Ctrl+K or Cmd+K, the sidebar's search button, or the
 * Search tab. On phones it fills the screen.
 */
export function QuickSwitcher() {
  const { open, setOpen } = useSwitcher();
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      label={t("switcher.label")}
      layoutClassName={
        "mx-auto mt-[110px] mb-auto max-h-[calc(100dvh-126px)] w-[calc(100%-32px)] max-w-[620px] rounded-card border " +
        "max-md:m-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:rounded-none max-md:border-0"
      }
    >
      <SwitcherPanel close={() => setOpen(false)} />
    </Dialog>
  );
}

function SwitcherPanel({ close }: { close: () => void }) {
  const session = useSession();
  const { locale, t, resolvedTheme, toggleTheme, setTheme, toggleLocale } = usePreferences();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo(
    () => buildSwitcherItems({ session, locale, resolvedTheme, t }),
    [session, locale, resolvedTheme, t],
  );

  const run = (item: SwitcherItem) => {
    switch (item.target.kind) {
      case "navigate":
        navigate(item.target.to);
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "system-theme":
        setTheme("system");
        break;
      case "toggle-locale":
        toggleLocale();
        break;
    }
    close();
  };

  return (
    <Command
      label={t("switcher.label")}
      filter={filter}
      loop
      // Ctrl+K closes the switcher, so cmdk must not also read it as "move up".
      vimBindings={false}
      className="flex max-h-[inherit] flex-col max-md:h-full"
    >
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-4 text-fg-3 focus-within:shadow-[inset_0_-2px_0_var(--hearth-accent)] max-md:h-[calc(56px+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)] max-md:pr-2">
        <Search size={16} aria-hidden="true" />
        {/* cmdk ignores Enter and the arrow keys while an input method is composing, so choosing a Chinese candidate never opens a result. */}
        <Command.Input
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          placeholder={t("switcher.placeholder")}
          aria-label={t("switcher.placeholder")}
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-lg text-fg outline-none placeholder:text-fg-3"
        />
        <button
          type="button"
          onClick={close}
          aria-label={t("switcher.close")}
          className="flex-none rounded-kbd border border-line bg-surface-2 px-[5px] text-2xs text-fg-3 max-md:hidden"
        >
          esc
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t("switcher.close")}
          className="inline-flex size-11 flex-none items-center justify-center rounded-ctl text-fg-2 md:hidden"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <Command.List
        label={t("switcher.label")}
        className="max-h-[420px] min-h-0 overflow-auto overscroll-contain p-2 max-md:max-h-none max-md:flex-1"
      >
        <Command.Empty className="px-2.5 py-4 text-xs text-fg-3">{t("switcher.empty")}</Command.Empty>
        {GROUPS.map((group) => {
          const groupItems = items.filter((item) => item.group === group.id);
          if (groupItems.length === 0) return null;
          return (
            <Command.Group key={group.id} heading={t(group.heading)}>
              {groupItems.map((item) => (
                <Command.Item
                  key={item.id}
                  value={item.id}
                  keywords={[item.label, ...item.keywords]}
                  onSelect={() => run(item)}
                >
                  {itemIcon(item)}
                  <span className="clip min-w-0 flex-1" lang={item.labelLang ? HTML_LANG[item.labelLang] : undefined}>
                    {item.label}
                  </span>
                  {/* The note can be a space's name, which people choose: it never takes more than half the row. */}
                  <span className="clip max-w-[50%] flex-none text-xs text-fg-3">{item.note}</span>
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}
      </Command.List>

      <div className="flex flex-none gap-4 border-t border-line bg-surface-2 px-4 py-2 text-xs text-fg-3 max-md:hidden">
        <span>{t("switcher.hintMove")}</span>
        <span>{t("switcher.hintOpen")}</span>
        <span>{t("switcher.hintClose")}</span>
      </div>
    </Command>
  );
}
