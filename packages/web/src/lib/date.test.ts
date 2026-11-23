import { describe, expect, it } from "vitest";
import { formatWhen } from "./date";

/** A time on this device's clock, as the reader sees it. */
const at = (year: number, month: number, day: number, hours: number, minutes: number) => new Date(year, month - 1, day, hours, minutes);

describe("formatWhen", () => {
  const now = at(2026, 11, 23, 15, 30);

  it("says how many minutes ago within the hour", () => {
    expect(formatWhen(at(2026, 11, 23, 15, 30), now, "en")).toBe("now");
    expect(formatWhen(at(2026, 11, 23, 15, 25), now, "en")).toBe("5 minutes ago");
    expect(formatWhen(at(2026, 11, 23, 15, 25), now, "zh")).toBe("5分钟前");
  });

  it("gives the time of day earlier today, and yesterday", () => {
    expect(formatWhen(at(2026, 11, 23, 9, 5), now, "en")).toBe("09:05");
    expect(formatWhen(at(2026, 11, 22, 23, 50), now, "en")).toBe("yesterday");
    expect(formatWhen(at(2026, 11, 22, 23, 50), now, "zh")).toBe("昨天");
  });

  it("gives the date before that, with the year when it is not this one", () => {
    expect(formatWhen(at(2026, 11, 3, 12, 0), now, "en")).toBe("Nov 3");
    expect(formatWhen(at(2026, 11, 3, 12, 0), now, "zh")).toBe("11月3日");
    expect(formatWhen(at(2025, 11, 3, 12, 0), now, "en")).toBe("Nov 3, 2025");
    expect(formatWhen(at(2025, 11, 3, 12, 0), now, "zh")).toBe("2025年11月3日");
  });
});
