/**
 * Two packages each list a few of the same names, because neither may import
 * the other: @hearth/sdk is what a mini-app's manifest is written with, and
 * @hearth/shared is what the server sends the web app. The web app is where
 * both arrive, so this is where they are compared.
 */
import { describe, expect, it } from "vitest";
import { SPACE_KINDS, WIDGET_SIZES } from "@hearth/sdk";
import { WIDGET_SIZES as SESSION_WIDGET_SIZES, spaceKindSchema } from "@hearth/shared";

describe("names the SDK and the session both use", () => {
  it("are the same card sizes", () => {
    expect([...SESSION_WIDGET_SIZES]).toEqual([...WIDGET_SIZES]);
  });

  it("are the same kinds of space", () => {
    expect([...spaceKindSchema.options]).toEqual([...SPACE_KINDS]);
  });
});
