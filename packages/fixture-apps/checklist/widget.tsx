import { Icon } from "@hearth/sdk/web";

/**
 * The body of the checklist's card on the dashboard. The shell draws the
 * card around it: icon, name, the space's tag and the link to the page.
 *
 * It cannot list the items yet. The hooks that give a widget its data, its
 * strings and its settings arrive with the step that draws widgets in the
 * shell; until then this draws the app's icon, which needs no words.
 */
export default function Widget() {
  return (
    <div className="flex min-h-[88px] flex-1 items-center justify-center text-fg-3">
      <Icon name="list-checks" size={28} />
    </div>
  );
}
