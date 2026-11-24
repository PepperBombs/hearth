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

/** Whole days from `date` to `now` on the reader's clock: 0 today, 1 yesterday. */
function daysBetween(date: Date, now: Date): number {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded: a day across a change of summer time is 23 or 25 hours long.
  return Math.round((day(now) - day(date)) / 86_400_000);
}

/** The parts a list by day is cut into, on the reader's clock. */
export type DayGroup = "today" | "yesterday" | "week" | "older";

/**
 * Which part of a list by day something falls in: today, yesterday, the 7
 * days before today (yesterday aside), or earlier. A time a little ahead of
 * this device's clock counts as today.
 */
export function dayGroup(date: Date, now: Date): DayGroup {
  const days = daysBetween(date, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  return "older";
}

/**
 * A short time for a row of a list: the time of day for today, otherwise
 * the date, with the year when it is not this one. "09:05", "Nov 3",
 * "11月3日", "Nov 3, 2025".
 */
export function formatListTime(date: Date, now: Date, locale: Locale): string {
  const tag = INTL[locale];
  if (daysBetween(date, now) <= 0) return new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return formatDay(date, now, locale);
}

/**
 * A day, with the year when it is not this one, on the reader's clock:
 * "Nov 3", "11月3日", "Nov 3, 2025".
 */
export function formatDay(date: Date, now: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL[locale], {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}
