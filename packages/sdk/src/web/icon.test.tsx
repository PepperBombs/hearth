import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { APP_COLORS, APP_ICONS } from "../index";
import { Icon, type IconProps } from "./index";

function drawn(props: IconProps): SVGSVGElement {
  const svg = render(<Icon {...props} />).container.querySelector("svg");
  if (!svg) throw new Error(`Nothing was drawn for ${props.name}`);
  return svg;
}

/** The Lucide class of the icon that was drawn, for example "lucide-shopping-bag". */
function lucideName(svg: SVGSVGElement): string {
  return Array.from(svg.classList).find((entry) => entry.startsWith("lucide-")) ?? "";
}

describe("Icon", () => {
  it("draws its own icon for every name the SDK lists", () => {
    const names = APP_ICONS.map((name) => lucideName(drawn({ name })));
    for (const name of names) expect(name).toMatch(/^lucide-/);
    expect(new Set(names).size).toBe(APP_ICONS.length);
    expect(lucideName(drawn({ name: "shopping-bag" }))).toBe("lucide-shopping-bag");
  });

  it("is 16 pixels unless told otherwise", () => {
    expect(drawn({ name: "star" }).getAttribute("width")).toBe("16");
    const large = drawn({ name: "star", size: 20 });
    expect(large.getAttribute("width")).toBe("20");
    expect(large.getAttribute("height")).toBe("20");
  });

  it("takes each app colour from its token, and the text colour when none is named", () => {
    for (const color of APP_COLORS) {
      expect(drawn({ name: "star", color }).style.color).toBe(`var(--hearth-app-${color})`);
    }
    expect(drawn({ name: "star" }).style.color).toBe("");
  });

  it("is hidden from screen readers unless it has a label", () => {
    const plain = drawn({ name: "star" });
    expect(plain.getAttribute("aria-hidden")).toBe("true");
    expect(plain.hasAttribute("role")).toBe(false);

    const named = drawn({ name: "star", label: "Starred" });
    expect(screen.getByRole("img", { name: "Starred" })).toBe(named);
    expect(named.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps the caller's classes", () => {
    expect(drawn({ name: "star", className: "text-fg-2" }).classList.contains("text-fg-2")).toBe(true);
  });
});
