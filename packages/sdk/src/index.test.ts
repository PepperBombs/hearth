/**
 * The type tests in this file are checked by `pnpm typecheck`, not by the
 * test runner: `expectTypeOf` and `@ts-expect-error` cost nothing at run
 * time, and a wrong type fails the type check.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_COLORS, APP_ICONS, APP_ID_PATTERN, type Manifest, type Setting } from "./index";

/** Takes a manifest as the server's code does: typed as `Manifest`, so that the compiler checks the literal. */
const manifest = (value: Manifest): Manifest => value;

/** What every manifest below starts from. */
const rest = {
  id: "x1",
  name: { en: "X", zh: "某" },
  description: { en: "X", zh: "某" },
  icon: "box",
  color: "blue",
  widget: { size: "small" },
} as const;

describe("the lists of allowed names", () => {
  it("has no duplicates", () => {
    expect(new Set(APP_ICONS).size).toBe(APP_ICONS.length);
    expect(new Set(APP_COLORS).size).toBe(APP_COLORS.length);
  });

  it("gives the unions their members", () => {
    expectTypeOf<"shopping-bag">().toExtend<Manifest["icon"]>();
    expectTypeOf<"rocket">().not.toExtend<Manifest["icon"]>();
    expectTypeOf<Manifest["color"]>().toEqualTypeOf<"green" | "purple" | "teal" | "amber" | "pink" | "orange" | "blue">();
  });

  it("describes an app ID: a lower-case letter, then 1 to 30 lower-case letters, digits and hyphens", () => {
    for (const id of ["grocery", "github-trending", "a1", "m-k3x9p2q7ab", `a${"b".repeat(30)}`]) expect(id).toMatch(APP_ID_PATTERN);
    for (const id of ["", "a", "Grocery", "1app", "-app", "my_app", "my app", `a${"b".repeat(31)}`]) {
      expect(id).not.toMatch(APP_ID_PATTERN);
    }
  });
});

describe("Manifest", () => {
  it("takes a manifest with only what is required, and one with everything", () => {
    expect(manifest({ ...rest })).toEqual(rest);
    const full = manifest({
      ...rest,
      spaces: ["personal", "group"],
      network: ["api.github.com"],
      settings: {
        hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" } },
        shop: { type: "text", scope: "space", default: "", maxLength: 40, label: { en: "Shop", zh: "商店" } },
        budget: { type: "number", scope: "space", default: 100, min: 0, step: 1, label: { en: "Budget", zh: "预算" } },
        period: {
          type: "select",
          scope: "user",
          default: "weekly",
          label: { en: "Period", zh: "周期" },
          options: { daily: { en: "Daily", zh: "每天" }, weekly: { en: "Weekly", zh: "每周" } },
        },
        diets: {
          type: "multi-select",
          scope: "user",
          default: ["vegan"],
          label: { en: "Diets", zh: "饮食" },
          options: { vegan: { en: "Vegan", zh: "纯素" }, halal: { en: "Halal", zh: "清真" } },
        },
        aisles: { type: "list", scope: "space", default: [], maxItems: 20, label: { en: "Aisles", zh: "货架" } },
      },
      messages: { en: { left: "{count} left" }, zh: { left: "还剩 {count} 项" } },
    });
    expect(Object.keys(full.settings ?? {})).toEqual(["hideDone", "shop", "budget", "period", "diets", "aisles"]);
  });

  it("rejects a wrong manifest at compile time", () => {
    // @ts-expect-error not one of the icons
    manifest({ ...rest, icon: "rocket" });
    // @ts-expect-error not one of the colours
    manifest({ ...rest, color: "red" });
    // @ts-expect-error not one of the sizes
    manifest({ ...rest, widget: { size: "huge" } });
    // @ts-expect-error the name needs both languages
    manifest({ ...rest, name: { en: "X" } });
    // @ts-expect-error not a kind of space
    manifest({ ...rest, spaces: ["team"] });
    // @ts-expect-error a switch's default is a boolean
    manifest({ ...rest, settings: { on: { type: "switch", scope: "user", default: "yes", label: { en: "On", zh: "开" } } } });
    // @ts-expect-error a setting's label needs both languages
    manifest({ ...rest, settings: { on: { type: "switch", scope: "user", default: true, label: { en: "On" } } } });
    // @ts-expect-error a setting is for the space or for the user
    manifest({ ...rest, settings: { on: { type: "switch", scope: "group", default: true, label: { en: "On", zh: "开" } } } });
    // @ts-expect-error not a kind of setting
    manifest({ ...rest, settings: { on: { type: "toggle", scope: "user", default: true, label: { en: "On", zh: "开" } } } });
    // @ts-expect-error not a property of a manifest
    manifest({ ...rest, colour: "blue" });
    // @ts-expect-error the hosts are a list
    manifest({ ...rest, network: "api.github.com" });
    // @ts-expect-error a host is a name
    manifest({ ...rest, network: [443] });
    // @ts-expect-error a message is a string
    manifest({ ...rest, messages: { en: { a: 1 }, zh: { a: "甲" } } });
  });

  it("takes the hosts an app fetches from, written in place or declared as a constant", () => {
    const HOSTS = ["api.github.com", "feeds.example.com"] as const;
    const inPlace = manifest({ ...rest, network: ["api.github.com"] });
    const constant = manifest({ ...rest, network: HOSTS });
    expect(inPlace.network).toEqual(["api.github.com"]);
    expect(constant.network).toBe(HOSTS);
    expectTypeOf<Manifest["network"]>().toEqualTypeOf<readonly string[] | undefined>();
  });
});

describe("Setting", () => {
  it("takes a list default written in place or declared as a constant", () => {
    const AISLES = ["Dairy", "Bakery"] as const;
    const constant: Setting = { type: "list", scope: "space", default: AISLES, label: { en: "Aisles", zh: "货架" } };
    const inPlace: Setting = { type: "list", scope: "space", default: ["Dairy"], label: { en: "Aisles", zh: "货架" } };
    const app = manifest({ ...rest, settings: { constant, inPlace } });
    expect(app.settings?.constant?.default).toBe(AISLES);
    expect(app.settings?.inPlace?.default).toEqual(["Dairy"]);
  });

  it("gives each kind of setting a default of its own kind", () => {
    expectTypeOf<Extract<Setting, { type: "text" }>["default"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<Setting, { type: "number" }>["default"]>().toEqualTypeOf<number>();
    expectTypeOf<Extract<Setting, { type: "switch" }>["default"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Extract<Setting, { type: "select" }>["default"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<Setting, { type: "multi-select" }>["default"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Extract<Setting, { type: "list" }>["default"]>().toEqualTypeOf<readonly string[]>();
  });
});
