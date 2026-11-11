import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { APP_COLORS, APP_ICONS, defineApp, type Manifest } from "./index";
import { manifestSchema } from "./manifest-schema";

/** A complete, valid manifest with one setting of every type. Each test changes one thing in a copy. */
function valid() {
  return {
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
        default: ["Dairy"],
        maxItems: 20,
        maxLength: 40,
        label: { en: "Aisles", zh: "货架" },
        help: { en: "Items are grouped in this order.", zh: "物品按此顺序分组。" },
      },
      hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" } },
      shop: { type: "text", scope: "space", default: "", maxLength: 40, label: { en: "Shop", zh: "商店" } },
      budget: { type: "number", scope: "space", default: 100, min: 0, max: 1000, step: 10, label: { en: "Budget", zh: "预算" } },
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
  };
}
type Draft = ReturnType<typeof valid>;

/** Where the schema found fault with `value`, as dotted paths; empty when it is accepted. */
function problems(value: unknown): string[] {
  const result = manifestSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

/** The paths the schema faults after `change` was applied to a valid manifest. */
function after(change: (draft: Draft) => void): string[] {
  const draft = valid();
  change(draft);
  return problems(draft);
}

/** Sets or deletes a property the draft's own type would not allow. */
function set(target: object, key: string, value: unknown): void {
  if (value === undefined) delete (target as Record<string, unknown>)[key];
  else (target as Record<string, unknown>)[key] = value;
}

describe("manifestSchema", () => {
  it("accepts a complete manifest and returns it as it was", () => {
    expect(problems(valid())).toEqual([]);
    expect(manifestSchema.parse(valid())).toEqual(valid());
  });

  it("accepts a manifest with only what is required", () => {
    const { id, name, description, icon, color, widget } = valid();
    expect(problems({ id, name, description, icon, color, widget })).toEqual([]);
  });

  it("accepts what defineApp returns", () => {
    const app = defineApp({
      id: "feed",
      name: { en: "Feed", zh: "动态" },
      description: { en: "What is new.", zh: "最新内容。" },
      icon: "trending-up",
      color: "orange",
      spaces: ["personal"],
      widget: { size: "wide" },
      settings: {
        languages: {
          type: "multi-select",
          scope: "user",
          default: [],
          label: { en: "Languages", zh: "语言" },
          options: { "c++": { en: "C++", zh: "C++" }, go: { en: "Go", zh: "Go" } },
        },
      },
    });
    expect(problems(app)).toEqual([]);
  });

  it("gives back a Manifest", () => {
    expectTypeOf<z.output<typeof manifestSchema>>().toEqualTypeOf<Manifest>();
    expectTypeOf(manifestSchema.parse(valid())).toEqualTypeOf<Manifest>();
  });

  it("accepts every icon and colour the SDK lists", () => {
    for (const icon of APP_ICONS) expect(after((draft) => set(draft, "icon", icon)), icon).toEqual([]);
    for (const color of APP_COLORS) expect(after((draft) => set(draft, "color", color)), color).toEqual([]);
  });

  describe("languages", () => {
    it("rejects a name, description, label, help or option with a language missing", () => {
      expect(after((draft) => set(draft.name, "zh", undefined))).toEqual(["name.zh"]);
      expect(after((draft) => set(draft.name, "en", undefined))).toEqual(["name.en"]);
      expect(after((draft) => set(draft.description, "zh", undefined))).toEqual(["description.zh"]);
      expect(after((draft) => set(draft.settings.hideDone.label, "zh", undefined))).toEqual(["settings.hideDone.label.zh"]);
      expect(after((draft) => set(draft.settings.aisles.help, "en", undefined))).toEqual(["settings.aisles.help.en"]);
      expect(after((draft) => set(draft.settings.period.options.daily, "zh", undefined))).toEqual([
        "settings.period.options.daily.zh",
      ]);
      expect(after((draft) => set(draft.settings.diets.options.halal, "en", undefined))).toEqual([
        "settings.diets.options.halal.en",
      ]);
    });

    it("rejects text that is empty or only spaces in either language", () => {
      expect(after((draft) => set(draft.name, "zh", ""))).toEqual(["name.zh"]);
      expect(after((draft) => set(draft.description, "en", "   "))).toEqual(["description.en"]);
      expect(after((draft) => set(draft.settings.shop.label, "zh", ""))).toEqual(["settings.shop.label.zh"]);
      expect(after((draft) => set(draft.messages.en, "empty", " "))).toEqual(["messages.en.empty"]);
    });

    it("rejects a third language and text that is not a string", () => {
      expect(after((draft) => set(draft.name, "fr", "Liste de courses"))).toEqual(["name"]);
      expect(after((draft) => set(draft.name, "zh", 7))).toEqual(["name.zh"]);
      expect(after((draft) => set(draft, "name", "Grocery list"))).toEqual(["name"]);
    });

    it("rejects a message that one language lacks", () => {
      expect(after((draft) => set(draft.messages.zh, "left", undefined))).toEqual(["messages.zh.left"]);
      expect(after((draft) => set(draft.messages.en, "left", undefined))).toEqual(["messages.zh.left"]);
      expect(after((draft) => set(draft.messages, "zh", undefined))).toEqual(["messages.zh"]);
    });

    it("rejects placeholders that differ between the languages", () => {
      expect(after((draft) => set(draft.messages.zh, "left", "还剩几项"))).toEqual(["messages.zh.left"]);
      expect(after((draft) => set(draft.messages.zh, "left", "还剩 {number} 项"))).toEqual(["messages.zh.left"]);
      expect(after((draft) => set(draft.messages.zh, "empty", "没有 {count}"))).toEqual(["messages.zh.empty"]);
      expect(after((draft) => set(draft.messages.zh, "moved", "已移动 {name}"))).toEqual(["messages.zh.moved"]);
    });

    it("lets a language reorder or repeat a placeholder", () => {
      expect(after((draft) => set(draft.messages.zh, "moved", "{aisle} 里有了 {name}，{name}"))).toEqual([]);
    });
  });

  describe("icon, colour and size", () => {
    it("rejects an unknown icon", () => {
      expect(after((draft) => set(draft, "icon", "rocket"))).toEqual(["icon"]);
      expect(after((draft) => set(draft, "icon", "ShoppingBag"))).toEqual(["icon"]);
      expect(after((draft) => set(draft, "icon", undefined))).toEqual(["icon"]);
    });

    it("rejects an unknown colour", () => {
      expect(after((draft) => set(draft, "color", "red"))).toEqual(["color"]);
      expect(after((draft) => set(draft, "color", "#1a7f45"))).toEqual(["color"]);
    });

    it("rejects an unknown widget size and a missing widget", () => {
      expect(after((draft) => set(draft.widget, "size", "huge"))).toEqual(["widget.size"]);
      expect(after((draft) => set(draft, "widget", undefined))).toEqual(["widget"]);
    });
  });

  describe("id", () => {
    it("rejects a bad ID", () => {
      for (const id of ["", "a", "Grocery", "1grocery", "-grocery", "my_app", "my app", "购物", "../grocery", `a${"b".repeat(31)}`]) {
        expect(after((draft) => set(draft, "id", id)), JSON.stringify(id)).toEqual(["id"]);
      }
      expect(after((draft) => set(draft, "id", undefined))).toEqual(["id"]);
      expect(after((draft) => set(draft, "id", 7))).toEqual(["id"]);
    });

    it("accepts lower-case letters, digits and hyphens, from 2 to 31 characters", () => {
      for (const id of ["a1", "github-trending", "notes2", `a${"b".repeat(30)}`]) {
        expect(after((draft) => set(draft, "id", id)), id).toEqual([]);
      }
    });
  });

  describe("spaces", () => {
    it("accepts one kind or both, and rejects none or an unknown kind", () => {
      expect(after((draft) => set(draft, "spaces", ["group"]))).toEqual([]);
      expect(after((draft) => set(draft, "spaces", []))).toEqual(["spaces"]);
      expect(after((draft) => set(draft, "spaces", ["personal", "team"]))).toEqual(["spaces.1"]);
    });
  });

  describe("unknown properties", () => {
    it("rejects them in the manifest, the widget and a setting", () => {
      expect(after((draft) => set(draft, "colour", "green"))).toEqual([""]);
      expect(after((draft) => set(draft, "hasPage", true))).toEqual([""]);
      expect(after((draft) => set(draft.widget, "width", 2))).toEqual(["widget"]);
      expect(after((draft) => set(draft.settings.hideDone, "maxLength", 3))).toEqual(["settings.hideDone"]);
      expect(after((draft) => set(draft.messages, "fr", {}))).toEqual(["messages"]);
    });

    it("rejects something that is not an object", () => {
      expect(problems(null)).toEqual([""]);
      expect(problems("grocery")).toEqual([""]);
      expect(problems([])).toEqual([""]);
    });
  });

  describe("settings", () => {
    it("rejects an unknown type or scope", () => {
      expect(after((draft) => set(draft.settings.shop, "type", "password"))).toEqual(["settings.shop.type"]);
      expect(after((draft) => set(draft.settings.shop, "scope", "group"))).toEqual(["settings.shop.scope"]);
      expect(after((draft) => set(draft.settings.shop, "label", undefined))).toEqual(["settings.shop.label"]);
    });

    it("rejects a name that is not a plain identifier", () => {
      for (const name of ["hide-done", "1st", "", "with space", "_private"]) {
        const found = after((draft) => set(draft.settings, name, draft.settings.hideDone));
        expect(found, JSON.stringify(name)).toEqual([`settings.${name}`]);
      }
      expect(after((draft) => set(draft.settings, "hide_done2", draft.settings.hideDone))).toEqual([]);
    });

    it("rejects a default of the wrong type", () => {
      expect(after((draft) => set(draft.settings.hideDone, "default", "yes"))).toEqual(["settings.hideDone.default"]);
      expect(after((draft) => set(draft.settings.shop, "default", 7))).toEqual(["settings.shop.default"]);
      expect(after((draft) => set(draft.settings.budget, "default", "100"))).toEqual(["settings.budget.default"]);
      expect(after((draft) => set(draft.settings.budget, "default", Number.NaN))).toEqual(["settings.budget.default"]);
      expect(after((draft) => set(draft.settings.aisles, "default", "Dairy"))).toEqual(["settings.aisles.default"]);
      expect(after((draft) => set(draft.settings.aisles, "default", [1]))).toEqual(["settings.aisles.default.0"]);
      expect(after((draft) => set(draft.settings.diets, "default", "vegan"))).toEqual(["settings.diets.default"]);
      expect(after((draft) => set(draft.settings.period, "default", undefined))).toEqual(["settings.period.default"]);
    });

    it("rejects a text default longer than maxLength", () => {
      expect(after((draft) => set(draft.settings.shop, "default", "x".repeat(41)))).toEqual(["settings.shop.default"]);
      expect(after((draft) => set(draft.settings.shop, "default", "x".repeat(40)))).toEqual([]);
    });

    it("rejects a number default outside min and max, and min above max", () => {
      expect(after((draft) => set(draft.settings.budget, "default", -1))).toEqual(["settings.budget.default"]);
      expect(after((draft) => set(draft.settings.budget, "default", 1001))).toEqual(["settings.budget.default"]);
      expect(after((draft) => set(draft.settings.budget, "default", 0))).toEqual([]);
      expect(after((draft) => set(draft.settings.budget, "default", 1000))).toEqual([]);
      expect(after((draft) => set(draft.settings.budget, "min", 500))).toEqual(["settings.budget.default"]);
      expect(
        after((draft) => {
          set(draft.settings.budget, "min", 100);
          set(draft.settings.budget, "max", 50);
        }),
      ).toEqual(["settings.budget.min", "settings.budget.default"]);
      expect(after((draft) => set(draft.settings.budget, "step", 0))).toEqual(["settings.budget.step"]);
    });

    it("rejects a select default that is not an option, and a select without options", () => {
      expect(after((draft) => set(draft.settings.period, "default", "monthly"))).toEqual(["settings.period.default"]);
      expect(after((draft) => set(draft.settings.period, "default", "toString"))).toEqual(["settings.period.default"]);
      // With no options there is nothing the default could be, so both are named.
      expect(after((draft) => set(draft.settings.period, "options", {}))).toEqual([
        "settings.period.options",
        "settings.period.default",
      ]);
      expect(after((draft) => set(draft.settings.period, "options", undefined))).toEqual(["settings.period.options"]);
    });

    it("rejects a multi-select default that is not an option or is listed twice", () => {
      expect(after((draft) => set(draft.settings.diets, "default", ["vegan", "kosher"]))).toEqual(["settings.diets.default.1"]);
      expect(after((draft) => set(draft.settings.diets, "default", ["vegan", "vegan"]))).toEqual(["settings.diets.default.1"]);
      expect(after((draft) => set(draft.settings.diets, "default", ["halal", "vegan"]))).toEqual([]);
      expect(after((draft) => set(draft.settings.diets, "default", []))).toEqual([]);
    });

    it("rejects a list default with too many items or too long an item", () => {
      expect(after((draft) => set(draft.settings.aisles, "default", Array.from({ length: 21 }, (_, n) => `Aisle ${n}`)))).toEqual([
        "settings.aisles.default",
      ]);
      expect(after((draft) => set(draft.settings.aisles, "default", ["Dairy", "x".repeat(41)]))).toEqual([
        "settings.aisles.default.1",
      ]);
      expect(after((draft) => set(draft.settings.aisles, "maxItems", -1))).toEqual([
        "settings.aisles.maxItems",
        "settings.aisles.default",
      ]);
      expect(after((draft) => set(draft.settings.aisles, "maxItems", 1.5))).toEqual(["settings.aisles.maxItems"]);
      expect(after((draft) => set(draft.settings.aisles, "maxLength", 1.5))).toEqual(["settings.aisles.maxLength"]);
    });
  });

  it("reports every problem at once, each with a message", () => {
    const result = manifestSchema.safeParse({ ...valid(), id: "Grocery", icon: "rocket", name: { en: "Grocery list" } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join(".")).sort()).toEqual(["icon", "id", "name.zh"]);
    for (const issue of result.error.issues) expect(issue.message).not.toBe("");
    expect(result.error.issues.find((issue) => issue.path[0] === "id")?.message).toContain("lower-case");
  });
});
