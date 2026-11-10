/** The application behind a real listening socket, as main.ts runs it. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { sessionSchema } from "@hearth/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_EMAIL, testApp, testConfig } from "./testing";

let server: ServerType;
let base: string;
let folder: string;
const script = `console.log(${JSON.stringify("x".repeat(200_000))});`;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "hearth-http-"));
  mkdirSync(join(folder, "assets"));
  writeFileSync(join(folder, "index.html"), "<!doctype html><title>Hearth</title>");
  writeFileSync(join(folder, "assets", "index-B1a2c3d4.js"), script);
  const { app } = testApp({
    config: testConfig({ webDist: folder, auth: { mode: "dev", devUser: OWNER_EMAIL } }),
    identify: "from-config",
  });
  const address = await new Promise<AddressInfo>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, resolve);
  });
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});

describe("over HTTP", () => {
  it("serves the session", async () => {
    const response = await fetch(`${base}/api/session`);
    expect(response.status).toBe(200);
    expect(sessionSchema.parse(await response.json()).user.email).toBe(OWNER_EMAIL);
  });

  it("streams a large file whole", async () => {
    const response = await fetch(`${base}/assets/index-B1a2c3d4.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(script.length));
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await response.text()).toBe(script);
  });

  it("answers HEAD and falls back to the page for client-side routes", async () => {
    const head = await fetch(`${base}/assets/index-B1a2c3d4.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(script.length));
    const page = await fetch(`${base}/apps/anything`);
    expect(await page.text()).toContain("<title>Hearth</title>");
  });

  it("checks Origin against the real Host header", async () => {
    const patch = (origin: string) =>
      fetch(`${base}/api/me`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ theme: "dark" }),
      });
    expect((await patch(base)).status).toBe(200);
    expect((await patch("https://evil.example.net")).status).toBe(403);
  });
});
