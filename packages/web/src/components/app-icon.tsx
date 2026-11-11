/**
 * An app's icon in the app's own colour.
 *
 * Apps name an icon and a colour in their manifest. Which names exist is
 * decided by the SDK (`APP_ICONS` and `APP_COLORS` in `@hearth/sdk`), and the
 * SDK's `Icon` draws them. The session describes apps with plain strings, and
 * a browser may hold an older build than the server, so here an unknown name
 * falls back to a neutral box and an unknown colour to the text colour.
 */
import { APP_COLORS, APP_ICONS } from "@hearth/sdk";
import { Icon } from "@hearth/sdk/web";

/** Whether a string from the session is one of the names in a list of the SDK. */
function isOneOf<T extends string>(names: readonly T[], value: string): value is T {
  return (names as readonly string[]).includes(value);
}

export function AppIcon({ icon, color, size = 16 }: { icon: string; color: string; size?: number }) {
  return (
    <Icon
      name={isOneOf(APP_ICONS, icon) ? icon : "box"}
      color={isOneOf(APP_COLORS, color) ? color : undefined}
      size={size}
      className="text-fg-2"
    />
  );
}

/** The Hearth mark: an arch over a hearth. Drawn here because it is the brand, not a stock icon. */
export function BrandMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 20V11a8 8 0 0 1 16 0v9M9 20v-6a3 3 0 0 1 6 0v6M2 20h20" />
    </svg>
  );
}
