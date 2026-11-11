import { render } from "@testing-library/react";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_COLORS, APP_ICONS, type Localized as SdkLocalized } from "@hearth/sdk";
import type { Localized } from "@hearth/shared";
import { AppIcon, appColorStyle } from "./app-icon";

/** The Lucide class of the icon that was drawn, for example "lucide-shopping-bag". */
function drawn(icon: string, color = "green"): { name: string; color: string } {
  const svg = render(<AppIcon icon={icon} color={color} />).container.querySelector("svg");
  if (!svg) throw new Error(`Nothing was drawn for ${icon}`);
  const name = Array.from(svg.classList).find((entry) => entry.startsWith("lucide-")) ?? "";
  return { name, color: svg.style.color };
}

describe("AppIcon", () => {
  it("draws its own icon for every name the SDK lists", () => {
    const names = APP_ICONS.map((icon) => drawn(icon).name);
    for (const name of names) expect(name).toMatch(/^lucide-/);
    expect(new Set(names).size).toBe(APP_ICONS.length);
    expect(drawn("shopping-bag").name).toBe("lucide-shopping-bag");
  });

  it("falls back to the box for a name it does not know", () => {
    const box = drawn("box").name;
    expect(drawn("rocket").name).toBe(box);
    expect(drawn("").name).toBe(box);
    // Names that exist on every object must not be taken for icons.
    expect(drawn("constructor").name).toBe(box);
    expect(drawn("toString").name).toBe(box);
  });

  it("colours the icon with the app's token, or leaves the text colour for an unknown colour", () => {
    for (const color of APP_COLORS) expect(appColorStyle(color)).toEqual({ color: `var(--hearth-app-${color})` });
    expect(drawn("box", "teal").color).toBe("var(--hearth-app-teal)");
    expect(appColorStyle("red")).toBeUndefined();
    expect(drawn("box", "red").color).toBe("");
  });
});

describe("text in both languages", () => {
  it("means the same in the SDK as in the contract with the server", () => {
    expectTypeOf<SdkLocalized>().toEqualTypeOf<Localized>();
  });
});
