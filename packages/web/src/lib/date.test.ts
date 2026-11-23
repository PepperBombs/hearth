import { describe, expect, it } from "vitest";
import { dayGroup, formatListTime } from "./date";

/** A time on this device's clock, as the reader sees it. */
const at = (year: number, month: number, day: number, hours: number, minutes: number) => new Date(year, month - 1, day, hours, minutes);

describe("dayGroup", () => {
  const now = at(2026, 11, 23, 0, 30);

  it("cuts a list into today, yesterday, the 7 days before and older, by the reader's calendar days", () => {
    expect(dayGroup(at(2026, 11, 23, 0, 5), now)).toBe("today");
    // Half an hour ago, but before midnight.
    expect(dayGroup(at(2026, 11, 22, 23, 59), now)).toBe("yesterday");
    expect(dayGroup(at(2026, 11, 22, 0, 0), now)).toBe("yesterday");
    expect(dayGroup(at(2026, 11, 21, 23, 59), now)).toBe("week");
    expect(dayGroup(at(2026, 11, 16, 0, 0), now)).toBe("week");
    expect(dayGroup(at(2026, 11, 15, 23, 59), now)).toBe("older");
    expect(dayGroup(at(2025, 11, 23, 0, 5), now)).toBe("older");
  });

  it("counts a time a little ahead of this device's clock as today", () => {
    expect(dayGroup(at(2026, 11, 23, 0, 31), now)).toBe("today");
    expect(dayGroup(at(2026, 11, 24, 0, 1), now)).toBe("today");
  });
});

describe("formatListTime", () => {
  const now = at(2026, 11, 23, 15, 30);

  it("gives the time of day for today, also within the hour", () => {
    expect(formatListTime(at(2026, 11, 23, 15, 29), now, "en")).toBe("15:29");
    expect(formatListTime(at(2026, 11, 23, 9, 5), now, "zh")).toBe("09:05");
  });

  it("gives the date before today, with the year when it is not this one", () => {
    expect(formatListTime(at(2026, 11, 22, 23, 50), now, "en")).toBe("Nov 22");
    expect(formatListTime(at(2026, 11, 3, 12, 0), now, "zh")).toBe("11月3日");
    expect(formatListTime(at(2025, 11, 3, 12, 0), now, "en")).toBe("Nov 3, 2025");
  });
});
