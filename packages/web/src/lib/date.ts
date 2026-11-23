import type { Locale } from "@hearth/shared";

/** Today as shown in the dashboard's top bar: "Tuesday, November 10" or "11月10日 星期二". */
export function formatToday(date: Date, locale: Locale): string {
  if (locale === "zh") {
    const day = new Intl.DateTimeFormat("zh-Hans-CN", { month: "numeric", day: "numeric" }).format(date);
    const weekday = new Intl.DateTimeFormat("zh-Hans-CN", { weekday: "long" }).format(date);
    return `${day} ${weekday}`;
  }
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(date);
}

const INTL: Record<Locale, string> = { en: "en-US", zh: "zh-Hans-CN" };

/**
 * When something last happened, on the reader's clock and in their language:
 * "now" or "5 minutes ago" within the hour, the time of day earlier today,
 * "yesterday", then the date, with the year when it is not this one.
 */
export function formatWhen(date: Date, now: Date, locale: Locale): string {
  const tag = INTL[locale];
  const relative = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return relative.format(0, "second");
  if (minutes < 60) return relative.format(-minutes, "minute");
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (days === 1) return relative.format(-1, "day");
  return new Intl.DateTimeFormat(tag, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}
