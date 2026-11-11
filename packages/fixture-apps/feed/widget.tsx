import { Icon } from "@hearth/sdk/web";

/**
 * The body of the feed's card on the dashboard.
 *
 * This app has no server file: what its card shows depends only on each
 * person's own settings. It cannot read them yet. The hooks that give a
 * widget its strings and its settings arrive with the step that draws
 * widgets in the shell; until then this draws the app's icon, which needs
 * no words.
 */
export default function Widget() {
  return (
    <div className="flex min-h-[72px] flex-1 items-center justify-center text-fg-3">
      <Icon name="trending-up" size={28} />
    </div>
  );
}
