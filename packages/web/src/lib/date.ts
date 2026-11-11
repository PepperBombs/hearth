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
