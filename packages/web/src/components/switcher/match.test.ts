import { describe, expect, it } from "vitest";
import { matchScore, normalize } from "./match";

describe("normalize", () => {
  it("lower-cases and folds full-width characters", () => {
    expect(normalize("  SeTTings ")).toBe("settings");
    expect(normalize("ｓｅｔ１")).toBe("set1");
  });
});

describe("matchScore", () => {
  const settings = ["Settings", "设置", "Me", "我", "preferences"];

  it("shows everything for an empty search", () => {
    expect(matchScore(settings, "")).toBe(1);
    expect(matchScore(settings, "   ")).toBe(1);
  });

  it("matches in either language whatever the interface language is", () => {
    expect(matchScore(settings, "sett")).toBeGreaterThan(0);
    expect(matchScore(settings, "设置")).toBeGreaterThan(0);
    expect(matchScore(settings, "设")).toBeGreaterThan(0);
    expect(matchScore(["设置", "Settings"], "SETTINGS")).toBeGreaterThan(0);
  });

  it("hides items that do not contain the text", () => {
    expect(matchScore(settings, "dash")).toBe(0);
    expect(matchScore(settings, "仪表盘")).toBe(0);
  });

  it("needs every word to match, in any order", () => {
    expect(matchScore(["Switch to dark mode", "theme"], "dark theme")).toBeGreaterThan(0);
    expect(matchScore(["Switch to dark mode", "theme"], "theme dark")).toBeGreaterThan(0);
    expect(matchScore(["Switch to dark mode", "theme"], "dark language")).toBe(0);
  });

  it("ranks a match at the start of the label above one inside it or in a keyword", () => {
    const atStart = matchScore(["Grocery"], "gro");
    const atWord = matchScore(["Open Grocery"], "gro");
    const inside = matchScore(["Agrobot"], "gro");
    const keyword = matchScore(["购物清单", "Grocery"], "gro");
    expect(atStart).toBeGreaterThan(atWord);
    expect(atWord).toBeGreaterThan(inside);
    expect(atStart).toBeGreaterThan(keyword);
  });

  it("accepts full-width letters typed through a Chinese input method", () => {
    expect(matchScore(settings, "ｓｅｔｔ")).toBeGreaterThan(0);
  });
});
