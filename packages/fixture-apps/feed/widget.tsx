import { Icon, appHooks } from "@hearth/sdk/web";
import type manifest from "./manifest";

const { useApp } = appHooks<typeof manifest>();

/**
 * The body of the feed's card on the dashboard.
 *
 * This app has no server file, so there is nothing to query: what its card
 * shows depends only on each person's own settings, which `useApp` hands
 * over together with `t` for the app's strings. With no server file, the
 * hooks are typed from the manifest.
 */
export default function Widget() {
  const { t, settings } = useApp();
  return (
    <div className="flex min-h-[72px] flex-1 flex-col items-center justify-center gap-1.5 text-fg-3">
      <Icon name="trending-up" size={28} />
      <p className="num text-xs">
        {settings.topics.length === 0 ? t("everything") : t("following", { count: settings.topics.length })}
      </p>
    </div>
  );
}
