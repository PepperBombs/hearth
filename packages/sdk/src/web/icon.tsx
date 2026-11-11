/**
 * Draws one of the icons the SDK lists (`APP_ICONS` in `@hearth/sdk`).
 *
 * The set is a short list of Lucide icons, so that the whole library is not
 * shipped and a mini-app needs no icon package of its own. To add an icon,
 * add its name to `APP_ICONS` and its Lucide icon here: a name without one
 * is a type error.
 */
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
import type { AppColor, AppIcon } from "../index";

const ICONS: Readonly<Record<AppIcon, LucideIcon>> = {
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

export type IconProps = {
  name: AppIcon;
  /** Width and height in pixels. */
  size?: number;
  /** One of the app colours. Left out, the icon takes the colour of the text around it. */
  color?: AppColor;
  /** Read by screen readers. Leave it out when the icon only decorates text that says the same. */
  label?: string;
  className?: string;
};

export function Icon({ name, size = 16, color, label, className }: IconProps) {
  const Drawn = ICONS[name];
  return (
    <Drawn
      size={size}
      className={className}
      // Each colour in the SDK's list is backed by a --hearth-app-* token in the shell's styles.
      style={color ? { color: `var(--hearth-app-${color})` } : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
