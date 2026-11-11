import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, initialOf } from "./avatar";

describe("Avatar", () => {
  it("uses the first character, whatever the script", () => {
    expect(initialOf("sam example")).toBe("S");
    expect(initialOf("  林悦")).toBe("林");
    expect(initialOf("👩‍🍳 Cook")).not.toBe("");
    expect(initialOf("")).toBe("");
    const { container } = render(<Avatar name="" />);
    expect(container.textContent).toBe("?");
  });
});
