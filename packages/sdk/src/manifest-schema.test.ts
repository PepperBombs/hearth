import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { APP_COLORS, APP_ICONS, defineApp, type Manifest, type Setting } from "./index";
import { manifestSchema, settingValueProblems } from "./manifest-schema";

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
    network: ["api.github.com"],
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

  describe("network", () => {
    /** Where the schema faults the manifest when its hosts are these. */
    const withHosts = (network: unknown) => after((draft) => set(draft, "network", network));
    /** What the schema says of the manifest's first host when its hosts are these. */
    const sayOfHosts = (network: unknown) => {
      const result = manifestSchema.safeParse({ ...valid(), network });
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };

    it("accepts lower-case DNS names, from one to ten, each once", () => {
      for (const network of [
        ["api.github.com"],
        ["api.github.com", "feeds.example.com"],
        Array.from({ length: 10 }, (_, n) => `feed${n}.example.com`),
        ["example.com", "a.b.c.example.org", "my-feeds.example.net", "1st.example.com", "xn--bcher-kva.example.com"],
        [`${"a".repeat(63)}.example.com`, `${Array.from({ length: 3 }, () => "a".repeat(63)).join(".")}.${"b".repeat(61)}`],
        // A name that merely starts like one of the local network leads out to the internet.
        ["localhost.example.com", "local.example.com", "printer.local.example.com", "home.arpa.example.com"],
      ]) {
        expect(withHosts(network), JSON.stringify(network)).toEqual([]);
      }
      expect(manifestSchema.parse({ ...valid(), network: ["api.github.com", "feeds.example.com"] }).network).toEqual([
        "api.github.com",
        "feeds.example.com",
      ]);
    });

    it("refuses a scheme, a port, a path, upper case, a wildcard and an IP address", () => {
      for (const host of [
        "https://api.github.com",
        "//api.github.com",
        "api.github.com:443",
        "api.github.com/search/repositories",
        "api.github.com?q=stars",
        "someone@api.github.com",
        "API.github.com",
        "Api.GitHub.com",
        "*.github.com",
        "192.0.2.1",
        "2001:db8::1",
        "[2001:db8::1]",
      ]) {
        expect(withHosts([host]), host).toEqual(["network.0"]);
      }
      expect(sayOfHosts(["https://api.github.com"])).toEqual([
        '"https://api.github.com" is not a host name. Write a lower-case DNS name such as api.github.com: no scheme, port, path, wildcard or IP address.',
      ]);
    });

    it("refuses what is not a DNS name of two or more labels", () => {
      for (const host of [
        "",
        "github",
        "api.github.com.",
        ".github.com",
        "api..github.com",
        " api.github.com",
        "api.github.com ",
        "-api.github.com",
        "api-.github.com",
        "api_v3.github.com",
        "api.github.c0m",
        "例子.example.com",
        // A label of 64 characters, and a name of 254.
        `${"a".repeat(64)}.example.com`,
        `${Array.from({ length: 3 }, () => "a".repeat(63)).join(".")}.${"b".repeat(62)}`,
      ]) {
        expect(withHosts([host]), JSON.stringify(host)).toEqual(["network.0"]);
      }
    });

    it("refuses a name of the local network", () => {
      for (const host of ["localhost", "printer.local", "app.localhost", "db.internal", "nas.home.arpa", "home.arpa"]) {
        expect(withHosts([host]), host).toEqual(["network.0"]);
      }
      expect(sayOfHosts(["printer.local"])).toEqual([
        '"printer.local" is a name of the local network. A job fetches from hosts on the internet only.',
      ]);
      expect(sayOfHosts(["localhost"])).toEqual(['"localhost" is a name of the local network. A job fetches from hosts on the internet only.']);
    });

    it("refuses a name twice, naming the second", () => {
      expect(withHosts(["api.github.com", "feeds.example.com", "api.github.com"])).toEqual(["network.2"]);
      expect(sayOfHosts(["api.github.com", "api.github.com"])).toEqual(['"api.github.com" is listed twice.']);
    });

    it("refuses an empty list and eleven names", () => {
      expect(withHosts([])).toEqual(["network"]);
      expect(sayOfHosts([])).toEqual(["List at least one host, or leave network out."]);
      const eleven = Array.from({ length: 11 }, (_, n) => `feed${n}.example.com`);
      expect(withHosts(eleven)).toEqual(["network"]);
      expect(sayOfHosts(eleven)).toEqual(["List at most 10 hosts."]);
    });

    it("refuses hosts that are not a list of texts, with one message", () => {
      // A text longer than ten characters is not also counted as too many hosts.
      expect(withHosts("api.github.com")).toEqual(["network"]);
      expect(sayOfHosts("api.github.com")[0]).toContain("expected array");
      expect(withHosts(null)).toEqual(["network"]);
      expect(withHosts({ 0: "api.github.com" })).toEqual(["network"]);
      expect(withHosts([443])).toEqual(["network.0"]);
    });

    it("names every problem at once", () => {
      expect(withHosts(["api.github.com", "localhost", "API.example.com", "api.github.com"])).toEqual([
        "network.1",
        "network.2",
        "network.3",
      ]);
      const elevenBad = [...Array.from({ length: 10 }, (_, n) => `feed${n}.example.com`), "localhost"];
      expect(withHosts(elevenBad)).toEqual(["network", "network.10"]);
    });

    it("may be left out", () => {
      expect(withHosts(undefined)).toEqual([]);
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

    it("rejects a number default that is not on the setting's steps", () => {
      expect(after((draft) => set(draft.settings.budget, "default", 105))).toEqual(["settings.budget.default"]);
      expect(after((draft) => set(draft.settings.budget, "step", 30))).toEqual(["settings.budget.default"]);
      expect(after((draft) => set(draft.settings.budget, "step", 25))).toEqual([]);
      // Steps are counted from min: 5, 15, 25 and so on.
      expect(
        after((draft) => {
          set(draft.settings.budget, "min", 5);
          set(draft.settings.budget, "default", 105);
        }),
      ).toEqual([]);
      // Without a step any number will do.
      expect(
        after((draft) => {
          set(draft.settings.budget, "step", undefined);
          set(draft.settings.budget, "default", 99.5);
        }),
      ).toEqual([]);
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

  it("says of a default what is wrong with it", () => {
    const draft = valid();
    set(draft.settings.shop, "default", "x".repeat(41));
    const result = manifestSchema.safeParse(draft);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.message)).toEqual([
      "The default does not fit the setting. Must be at most 40 characters long.",
    ]);
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

describe("settingValueProblems", () => {
  const settings = valid().settings as unknown as Record<string, Setting>;
  /** Where the value does not fit the setting of this name, as dotted paths; "" is the value itself. */
  const found = (name: string, value: unknown, change: Partial<Record<string, unknown>> = {}) =>
    settingValueProblems({ ...settings[name], ...change } as Setting, value).map(([path]) => path.join("."));

  it("accepts every default of a valid manifest", () => {
    for (const [name, setting] of Object.entries(settings)) expect(found(name, setting.default), name).toEqual([]);
  });

  it("checks a text", () => {
    expect(found("shop", "Corner shop")).toEqual([]);
    expect(found("shop", "")).toEqual([]);
    expect(found("shop", "x".repeat(40))).toEqual([]);
    expect(found("shop", "x".repeat(41))).toEqual([""]);
    expect(found("shop", "x".repeat(4000), { maxLength: undefined })).toEqual([]);
    for (const value of [7, true, null, undefined, ["Corner shop"], { text: "Corner shop" }]) {
      expect(found("shop", value), JSON.stringify(value)).toEqual([""]);
    }
  });

  it("checks a number against min, max and step", () => {
    for (const value of [0, 10, 990, 1000]) expect(found("budget", value), String(value)).toEqual([]);
    for (const value of [-10, 1010, 5, 99.5, Number.NaN, Number.POSITIVE_INFINITY, "100", null, undefined, [100]]) {
      expect(found("budget", value), String(value)).toEqual([""]);
    }
    expect(found("budget", -10, { min: undefined })).toEqual([]);
    expect(found("budget", 5000, { max: undefined })).toEqual([]);
    expect(found("budget", 99.5, { step: undefined })).toEqual([]);
  });

  it("counts steps from min, or from 0 without one", () => {
    expect(found("budget", 13, { min: 3 })).toEqual([]);
    expect(found("budget", 10, { min: 3 })).toEqual([""]);
    expect(found("budget", -20, { min: undefined })).toEqual([]);
    expect(found("budget", -25, { min: undefined })).toEqual([""]);
  });

  it("takes whole numbers only with a step of 1", () => {
    expect(found("budget", 7, { step: 1 })).toEqual([]);
    expect(found("budget", 7.5, { step: 1 })).toEqual([""]);
    expect(found("budget", 7.000001, { step: 1 })).toEqual([""]);
  });

  it("allows for steps that a computer cannot hold exactly", () => {
    const tenths = { min: undefined, max: undefined, step: 0.1 };
    // 0.1 + 0.2 is not quite 0.3, and 0.3 / 0.1 is not quite 3.
    for (const value of [0.3, 0.1 + 0.2, 0.7, 1.1, 2.3, 123456.7, -0.9]) {
      expect(found("budget", value, tenths), String(value)).toEqual([]);
    }
    for (const value of [0.35, 0.301, 123456.75]) expect(found("budget", value, tenths), String(value)).toEqual([""]);
    expect(found("budget", 0.75, { min: 0.25, max: undefined, step: 0.25 })).toEqual([]);
  });

  it("checks a switch", () => {
    expect(found("hideDone", true)).toEqual([]);
    expect(found("hideDone", false)).toEqual([]);
    for (const value of ["true", 1, 0, null, undefined, [true]]) expect(found("hideDone", value), String(value)).toEqual([""]);
  });

  it("checks a select against its options", () => {
    expect(found("period", "daily")).toEqual([]);
    for (const value of ["monthly", "", "Daily", "toString", "constructor", "__proto__", 1, null, undefined, ["daily"]]) {
      expect(found("period", value), String(value)).toEqual([""]);
    }
  });

  it("checks every key of a multi-select", () => {
    expect(found("diets", [])).toEqual([]);
    expect(found("diets", ["halal", "vegan"])).toEqual([]);
    expect(found("diets", ["vegan", "kosher", "halal", "vegan", 3])).toEqual(["1", "3", "4"]);
    expect(found("diets", ["toString"])).toEqual(["0"]);
    for (const value of ["vegan", { vegan: true }, null, undefined, true]) {
      expect(found("diets", value), String(value)).toEqual([""]);
    }
  });

  it("checks a list and every item in it", () => {
    expect(found("aisles", [])).toEqual([]);
    expect(found("aisles", ["Dairy", "Bakery", "Dairy", ""])).toEqual([]);
    expect(found("aisles", Array.from({ length: 20 }, (_, n) => `Aisle ${n}`))).toEqual([]);
    expect(found("aisles", Array.from({ length: 21 }, (_, n) => `Aisle ${n}`))).toEqual([""]);
    expect(found("aisles", ["Dairy", "x".repeat(41), 7, null])).toEqual(["1", "2", "3"]);
    expect(found("aisles", Array.from({ length: 300 }, () => "x".repeat(300)), { maxItems: undefined, maxLength: undefined })).toEqual([]);
    for (const value of ["Dairy", { 0: "Dairy" }, null, undefined, 3]) {
      expect(found("aisles", value), String(value)).toEqual([""]);
    }
  });

  it("gives each problem a message", () => {
    expect(settingValueProblems(settings.budget as Setting, 5)).toEqual([[[], "Must be 0 plus a whole number of steps of 10."]]);
    expect(settingValueProblems(settings.diets as Setting, ["kosher"])).toEqual([[[0], '"kosher" is not one of the options.']]);
  });
});
