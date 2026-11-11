/**
 * An app's icon in the app's own colour.
 *
 * Apps name an icon and a colour in their manifest. Which names exist is
 * decided by the SDK (`APP_ICONS` and `APP_COLORS` in `@hearth/sdk`); this
 * file draws them. The icon set is a short list of Lucide icons so that the
 * whole library is not shipped. The session describes apps with plain
 * strings, and a browser may hold an older build than the server, so an
 * unknown name falls back to a neutral box and an unknown colour to the text
 * colour.
 */
import { APP_COLORS, type AppIcon as AppIconName } from "@hearth/sdk";
import {
  Bookmark,
  Box,
  Calendar,
  ChartColumn,
  ChartLine,
  Clock,
  CloudSun,
  CreditCard,
  FileText,
  Heart,
  Image,
  Link,
  ListChecks,
  Music,
  NotebookText,
  ShoppingBag,
  Star,
  TrendingUp,
  Users,
  Utensils,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

/** One Lucide icon for every name in the SDK's list: a name without one is a type error. */
const ICONS: Readonly<Record<AppIconName, LucideIcon>> = {
  bookmark: Bookmark,
  box: Box,
  calendar: Calendar,
  "chart-column": ChartColumn,
  "chart-line": ChartLine,
  clock: Clock,
  "cloud-sun": CloudSun,
  "credit-card": CreditCard,
  "file-text": FileText,
  heart: Heart,
  image: Image,
  link: Link,
  "list-checks": ListChecks,
  music: Music,
  "notebook-text": NotebookText,
  "shopping-bag": ShoppingBag,
  star: Star,
  "trending-up": TrendingUp,
  users: Users,
  utensils: Utensils,
  wallet: Wallet,
};

/** Each colour in the SDK's list is backed by a --hearth-app-* token in styles/tokens.css. */
export function appColorStyle(color: string): CSSProperties | undefined {
  return (APP_COLORS as readonly string[]).includes(color) ? { color: `var(--hearth-app-${color})` } : undefined;
}

export function AppIcon({ icon, color, size = 16 }: { icon: string; color: string; size?: number }) {
  const Icon = Object.hasOwn(ICONS, icon) ? ICONS[icon as AppIconName] : Box;
  return <Icon size={size} aria-hidden="true" className="text-fg-2" style={appColorStyle(color)} />;
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
