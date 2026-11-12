/**
 * The type tests in this file are checked by `pnpm typecheck`, not by the
 * test runner: `expectTypeOf` and `@ts-expect-error` cost nothing at run
 * time, and a wrong type fails the type check.
 */
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  APP_COLORS,
  APP_ICONS,
  APP_ID_PATTERN,
  SDK_VERSION,
  defineApp,
  type Manifest,
  type MessageKey,
  type PlaceholderArgs,
  type SettingsOf,
  type SpaceSettingsOf,
  type Translate,
} from "./index";

/** The example from the contract, plus one setting of every type. */
const grocery = defineApp({
  id: "grocery",
  name: { en: "Grocery list", zh: "购物清单" },
  description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
  icon: "shopping-bag",
  color: "green",
  spaces: ["personal", "group"],
  widget: { size: "tall" },
  settings: {
    aisles: {
      type: "list",
      scope: "space",
      default: [],
      maxItems: 20,
      label: { en: "Aisles", zh: "货架" },
      help: { en: "Items are grouped in this order.", zh: "物品按此顺序分组。" },
    },
    hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" } },
    shop: { type: "text", scope: "space", default: "", maxLength: 40, label: { en: "Shop", zh: "商店" } },
    budget: { type: "number", scope: "space", default: 100, min: 0, label: { en: "Budget", zh: "预算" } },
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
  },
  messages: {
    en: { empty: "Nothing to buy.", left: "{count} left", moved: "Moved {name} to {aisle}" },
    zh: { empty: "没有要买的东西。", left: "还剩 {count} 项", moved: "已将 {name} 移到 {aisle}" },
  },
});
type Grocery = typeof grocery;

/** An app with neither settings nor strings. */
const bare = defineApp({
  id: "bare",
  name: { en: "Bare", zh: "空白" },
  description: { en: "Nothing in it.", zh: "什么都没有。" },
  icon: "box",
  color: "blue",
  widget: { size: "small" },
});

describe("SDK_VERSION", () => {
  it("is the version in package.json, which the mini-apps repository is checked against", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(manifest.version);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

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

  it("describes an app ID as the contract does", () => {
    for (const id of ["grocery", "github-trending", "a1", `a${"b".repeat(30)}`]) expect(id).toMatch(APP_ID_PATTERN);
    for (const id of ["", "a", "Grocery", "1app", "-app", "my_app", "my app", `a${"b".repeat(31)}`]) {
      expect(id).not.toMatch(APP_ID_PATTERN);
    }
  });
});

describe("defineApp", () => {
  it("returns the manifest it was given", () => {
    const manifest = {
      id: "bare",
      name: { en: "Bare", zh: "空白" },
      description: { en: "Nothing in it.", zh: "什么都没有。" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
    } as const;
    expect(defineApp(manifest)).toBe(manifest);
  });

  it("gives a manifest that framework code can take as a plain Manifest", () => {
    expectTypeOf(grocery).toExtend<Manifest>();
    expectTypeOf(bare).toExtend<Manifest>();
  });

  it("rejects a wrong manifest at compile time", () => {
    const rest = {
      id: "x1",
      name: { en: "X", zh: "某" },
      description: { en: "X", zh: "某" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
    } as const;
    // @ts-expect-error not one of the icons
    defineApp({ ...rest, icon: "rocket" });
    // @ts-expect-error not one of the colours
    defineApp({ ...rest, color: "red" });
    // @ts-expect-error not one of the sizes
    defineApp({ ...rest, widget: { size: "huge" } });
    // @ts-expect-error the name needs both languages
    defineApp({ ...rest, name: { en: "X" } });
    // @ts-expect-error not a kind of space
    defineApp({ ...rest, spaces: ["team"] });
    // @ts-expect-error a switch's default is a boolean
    defineApp({ ...rest, settings: { on: { type: "switch", scope: "user", default: "yes", label: { en: "On", zh: "开" } } } });
    // @ts-expect-error a setting's label needs both languages
    defineApp({ ...rest, settings: { on: { type: "switch", scope: "user", default: true, label: { en: "On" } } } });
    // @ts-expect-error a setting is for the space or for the user
    defineApp({ ...rest, settings: { on: { type: "switch", scope: "group", default: true, label: { en: "On", zh: "开" } } } });
    // @ts-expect-error not a property of a manifest
    defineApp({ ...rest, colour: "blue" });
    // @ts-expect-error the hosts are a list
    defineApp({ ...rest, network: "api.github.com" });
    // @ts-expect-error a host is a name
    defineApp({ ...rest, network: [443] });
  });

  it("takes the hosts an app fetches from, written in place or declared as a constant", () => {
    const rest = {
      id: "x1",
      name: { en: "X", zh: "某" },
      description: { en: "X", zh: "某" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
    } as const;
    const HOSTS = ["api.github.com", "feeds.example.com"] as const;
    const inPlace = defineApp({ ...rest, network: ["api.github.com"] });
    const constant = defineApp({ ...rest, network: HOSTS });
    expect(inPlace.network).toEqual(["api.github.com"]);
    expect(constant.network).toBe(HOSTS);
    expectTypeOf(inPlace).toExtend<Manifest>();
    expectTypeOf(constant).toExtend<Manifest>();
    expectTypeOf<Manifest["network"]>().toEqualTypeOf<readonly string[] | undefined>();
  });
});

describe("message keys", () => {
  it("are the keys of the English strings", () => {
    expectTypeOf<MessageKey<Grocery>>().toEqualTypeOf<"empty" | "left" | "moved">();
  });

  it("are none at all for an app without strings", () => {
    expectTypeOf<MessageKey<typeof bare>>().toBeNever();
  });

  it("are any string when the manifest is not known exactly", () => {
    expectTypeOf<MessageKey<Manifest>>().toEqualTypeOf<string>();
  });

  it("must all exist in Chinese", () => {
    const rest = {
      id: "x1",
      name: { en: "X", zh: "某" },
      description: { en: "X", zh: "某" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
    } as const;
    const ok = defineApp({ ...rest, messages: { en: { a: "A", b: "B" }, zh: { a: "甲", b: "乙" } } });
    expectTypeOf<MessageKey<typeof ok>>().toEqualTypeOf<"a" | "b">();
    expect(ok.messages).toEqual({ en: { a: "A", b: "B" }, zh: { a: "甲", b: "乙" } });
    // @ts-expect-error zh lacks "b"
    defineApp({ ...rest, messages: { en: { a: "A", b: "B" }, zh: { a: "甲" } } });
    // @ts-expect-error zh has "c", which en does not define
    defineApp({ ...rest, messages: { en: { a: "A" }, zh: { a: "甲", c: "丙" } } });
    // @ts-expect-error a message is a string
    defineApp({ ...rest, messages: { en: { a: 1 }, zh: { a: "甲" } } });
  });
});

describe("placeholders", () => {
  it("are read from the English text", () => {
    expectTypeOf<PlaceholderArgs<Grocery, "empty">>().toEqualTypeOf<[]>();
    expectTypeOf<PlaceholderArgs<Grocery, "left">>().toEqualTypeOf<[values: Record<"count", string | number>]>();
    expectTypeOf<PlaceholderArgs<Grocery, "moved">>().toEqualTypeOf<[values: Record<"name" | "aisle", string | number>]>();
  });

  it("make t require exactly the values a string needs", () => {
    const t = ((key: string) => key) as Translate<Grocery>;
    expectTypeOf(t("empty")).toBeString();
    t("left", { count: 3 });
    t("moved", { name: "Milk", aisle: "Dairy" });
    // @ts-expect-error not a key
    t("nope");
    // @ts-expect-error this string needs { count }
    t("left");
    // @ts-expect-error wrong placeholder name
    t("left", { number: 3 });
    // @ts-expect-error this string needs { aisle } as well
    t("moved", { name: "Milk" });
    // @ts-expect-error this string takes no values
    t("empty", { count: 3 });
    // @ts-expect-error a value is text or a number
    t("left", { count: true });
  });

  it("leave t with nothing to call for an app without strings", () => {
    const t = ((key: string) => key) as Translate<typeof bare>;
    // @ts-expect-error the app has no strings
    t("empty");
  });

  it("are optional and unchecked when the English text is only known to be a string", () => {
    // What a sibling file without `as const` gives: the keys, but not the text.
    const en: { empty: string; left: string } = { empty: "Nothing to buy.", left: "{count} left" };
    const zh: { empty: string; left: string } = { empty: "没有要买的东西。", left: "还剩 {count} 项" };
    const loose = defineApp({
      id: "loose",
      name: { en: "Loose", zh: "宽松" },
      description: { en: "Strings from a sibling file.", zh: "来自同级文件的字符串。" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
      messages: { en, zh },
    });
    expect(loose.messages?.en).toBe(en);
    expectTypeOf<MessageKey<typeof loose>>().toEqualTypeOf<"empty" | "left">();
    expectTypeOf<PlaceholderArgs<typeof loose, "left">>().toEqualTypeOf<[values?: Record<string, string | number>]>();
    expectTypeOf<PlaceholderArgs<Manifest, string>>().toEqualTypeOf<[values?: Record<string, string | number>]>();
  });
});

describe("SettingsOf", () => {
  it("gives each setting the type of its value", () => {
    expectTypeOf<SettingsOf<Grocery>>().toEqualTypeOf<{
      aisles: string[];
      hideDone: boolean;
      shop: string;
      budget: number;
      period: "daily" | "weekly";
      diets: ("vegan" | "halal")[];
    }>();
  });

  it("matches the contract's example for the two grocery settings", () => {
    expectTypeOf<Pick<SettingsOf<Grocery>, "aisles" | "hideDone">>().toEqualTypeOf<{ aisles: string[]; hideDone: boolean }>();
  });

  it("takes a list default written in place or declared as a constant", () => {
    const AISLES = ["Dairy", "Bakery"] as const;
    const app = defineApp({
      id: "x1",
      name: { en: "X", zh: "某" },
      description: { en: "X", zh: "某" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
      settings: {
        constant: { type: "list", scope: "space", default: AISLES, label: { en: "Aisles", zh: "货架" } },
        inPlace: { type: "list", scope: "space", default: ["Dairy"], label: { en: "Aisles", zh: "货架" } },
      },
    });
    expect(app.settings?.constant.default).toBe(AISLES);
    expectTypeOf<SettingsOf<typeof app>>().toEqualTypeOf<{ constant: string[]; inPlace: string[] }>();
  });

  it("is empty for an app without settings", () => {
    expectTypeOf<keyof SettingsOf<typeof bare>>().toBeNever();
  });

  it("is a record of any setting value when the manifest is not known exactly", () => {
    expectTypeOf<SettingsOf<Manifest>>().toEqualTypeOf<{ [name: string]: string | number | boolean | string[] }>();
  });
});

describe("SpaceSettingsOf, the settings a job sees", () => {
  it("gives the settings of the space alone, each typed as in SettingsOf", () => {
    expectTypeOf<SpaceSettingsOf<Grocery>>().toEqualTypeOf<{ aisles: string[]; shop: string; budget: number }>();
    expectTypeOf<SpaceSettingsOf<Grocery>>().toEqualTypeOf<Pick<SettingsOf<Grocery>, "aisles" | "shop" | "budget">>();
  });

  it("is empty for an app without settings, and for one whose settings are each person's own", () => {
    const own = defineApp({
      id: "x1",
      name: { en: "X", zh: "某" },
      description: { en: "X", zh: "某" },
      icon: "box",
      color: "blue",
      widget: { size: "small" },
      settings: { hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide", zh: "隐藏" } } },
    });
    expectTypeOf<keyof SpaceSettingsOf<typeof bare>>().toBeNever();
    expectTypeOf<keyof SpaceSettingsOf<typeof own>>().toBeNever();
    expectTypeOf<keyof SettingsOf<typeof own>>().toEqualTypeOf<"hideDone">();
  });

  it("is a record of any setting value when the manifest is not known exactly", () => {
    expectTypeOf<SpaceSettingsOf<Manifest>>().toEqualTypeOf<{ [name: string]: string | number | boolean | string[] }>();
  });
});
