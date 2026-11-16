/**
 * In development the page comes from Vite's dev server, which hands the
 * server's own addresses on to it. The Assistant card names the page's
 * origin with /mcp as the address for an assistant (docs/mini-app-contract.md,
 * section F), so the dev server must hand that address on as well, and no
 * page of the web app with it.
 */
import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("the dev server's proxy", () => {
  const proxy = config.server?.proxy ?? {};
  // Vite reads a key that starts with "^" as a regular expression, and any other as the start of a path.
  const handedOn = (path: string) =>
    Object.keys(proxy).some((key) => (key.startsWith("^") ? new RegExp(key).test(path) : path.startsWith(key)));

  it("hands the API and the assistant's endpoint on to the server", () => {
    expect(handedOn("/api/session")).toBe(true);
    expect(handedOn("/mcp")).toBe(true);
  });

  it("keeps every page of the web app, also one whose path begins like the endpoint's", () => {
    for (const path of ["/", "/settings", "/apps", "/mcpx", "/mcp/tools"]) expect(handedOn(path), path).toBe(false);
  });
});
