import { describe, expect, it } from "vitest";
import { normaliseEmail } from "./email";

describe("normaliseEmail", () => {
  it("trims and lower-cases", () => {
    expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  });

  it("gives one spelling to a letter with an accent, however it was sent", () => {
    const composed = "josé@example.com";
    const decomposed = "josé@example.com";
    expect(decomposed).not.toBe(composed);
    expect(normaliseEmail(composed)).toBe(composed);
    expect(normaliseEmail(decomposed)).toBe(composed);
    expect(normaliseEmail("JOSÉ@example.com")).toBe(composed);
  });

  it("keeps addresses in other scripts", () => {
    expect(normaliseEmail("林@example.com")).toBe("林@example.com");
  });

  it.each([
    ["the Kelvin sign, which lower-cases to k", "miKe@example.com"],
    ["a capital I with a dot, which lower-cases to i plus a mark", "mİke@example.com"],
    ["a full-width letter", "ｍike@example.com"],
    ["a full-width at sign", "mike＠example.com"],
    ["a ligature", "ﬁona@example.com"],
    ["a no-break space", "mike x@example.com"],
  ])("refuses %s", (_label, address) => {
    expect(normaliseEmail(address)).toBeNull();
  });

  it("refuses text that is not an address", () => {
    for (const text of ["", "   ", "sam", "@example.com", "sam@", "sam @example.com", "a@b@c"]) {
      expect(normaliseEmail(text)).toBeNull();
    }
  });

  it("changes nothing the second time", () => {
    for (const address of ["Sam@Example.com", "JOSÉ@example.com", "林@example.com"]) {
      const once = normaliseEmail(address)!;
      expect(normaliseEmail(once)).toBe(once);
    }
  });
});
