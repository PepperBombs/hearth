import { Search } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { IconButton } from "@hearth/sdk/web";
import { cx } from "../../lib/cx";
import { useI18n } from "../../session/preferences";
import { useSwitcher } from "./switcher-state";

export type PageProps = {
  /** Shown in the top bar and in the browser tab. */
  title: string;
  /** A short note next to the title, hidden on phones. */
  note?: ReactNode;
  /**
   * A tag right after the title, on phones too, such as the group an app's
   * page belongs to. It gets the room the title leaves, and is cut short if
   * that is not enough.
   */
  tag?: ReactNode;
  /** Buttons at the right end of the top bar, on phones too, such as an app's settings. */
  actions?: ReactNode;
  children: ReactNode;
  /** Classes for the scrolling content area. */
  className?: string;
};

/** A screen inside the shell: the top bar with its title, then the scrolling content. */
export function Page({ title, note, tag, actions, children, className }: PageProps) {
  const { t } = useI18n();
  const switcher = useSwitcher();

  useEffect(() => {
    document.title = `${title} · Hearth`;
  }, [title]);

  return (
    <>
      <header
        className={cx(
          "flex flex-none items-center gap-3 border-b border-line bg-surface",
          "h-[calc(56px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]",
          "pr-[max(24px,env(safe-area-inset-right))] pl-6",
          "max-md:pr-[max(8px,env(safe-area-inset-right))] max-md:pl-[max(16px,env(safe-area-inset-left))]",
        )}
      >
        <h1 className="clip min-w-0 text-xl font-semibold">{title}</h1>
        {/* Starting from no width, this takes what is left and never squeezes the title. */}
        {tag ? <span className="flex min-w-7 flex-1">{tag}</span> : null}
        {note ? <span className="flex-none text-xs text-fg-3 max-md:hidden">{note}</span> : null}
        <div className="ml-auto flex flex-none items-center gap-1">
          {actions}
          <IconButton label={t("topbar.search")} className="md:hidden" onClick={() => switcher.setOpen(true)}>
            <Search size={20} aria-hidden="true" />
          </IconButton>
        </div>
      </header>
      <main
        id="content"
        tabIndex={-1}
        className={cx(
          "min-h-0 flex-1 overflow-auto p-6 outline-none",
          "max-md:p-4 max-md:pr-[max(16px,env(safe-area-inset-right))] max-md:pl-[max(16px,env(safe-area-inset-left))]",
          className,
        )}
      >
        {children}
      </main>
    </>
  );
}
