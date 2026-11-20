/**
 * In development the page comes from Vite's dev server, which hands the
 * server's own addresses on to it: the API, and no page of the web app.
 */
import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("the dev server's proxy", () => {
  const proxy = config.server?.proxy ?? {};
  // Vite reads a key that starts with "^" as a regular expression, and any other as the start of a path.
  const handedOn = (path: string) =>
    Object.keys(proxy).some((key) => (key.startsWith("^") ? new RegExp(key).test(path) : path.startsWith(key)));

  it("hands the API on to the server", () => {
    expect(handedOn("/api/session")).toBe(true);
  });

  it("keeps every page of the web app", () => {
    for (const path of ["/", "/apps", "/apps/family/checklist", "/chat", "/settings"]) expect(handedOn(path), path).toBe(false);
  });
});
