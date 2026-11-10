import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testApp, testConfig } from "../testing";
import { cacheControlFor, resolveInside } from "./static";

const BASE = "http://hearth.example.com";
const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';
const FOREVER = "public, max-age=31536000, immutable";

let parent: string;
let webDist: string;

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), "hearth-web-"));
  webDist = join(parent, "dist");
  mkdirSync(join(webDist, "assets"), { recursive: true });
  mkdirSync(join(webDist, "icons"));
  writeFileSync(join(webDist, "index.html"), INDEX);
  writeFileSync(join(webDist, "assets", "index-B1a2c3d4.js"), "console.log('app');");
  writeFileSync(join(webDist, "assets", "index-E5f6a7b8.css"), "body{margin:0}");
  writeFileSync(join(webDist, "assets", "inter-C9d0e1f2.woff2"), "font");
  writeFileSync(join(webDist, "sw.js"), "self.addEventListener('fetch', () => {});");
  writeFileSync(join(webDist, "manifest.webmanifest"), '{"name":"Hearth"}');
  writeFileSync(join(webDist, "icons", "icon-192.png"), "png");
  writeFileSync(join(webDist, ".secret"), "hidden");
  writeFileSync(join(parent, "outside.txt"), "outside the web folder");
  return () => rmSync(parent, { recursive: true, force: true });
});

const appWith = (dist: string) => testApp({ config: testConfig({ webDist: dist }) }).app;
const get = (path: string, init?: RequestInit) => appWith(webDist).request(`${BASE}${path}`, init);

describe("the built web app", () => {
  it("serves index.html at / and never lets it go stale", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(INDEX);
  });

  it.each(["/apps", "/apps/grocery/list", "/me", "/search?q=milk", "/missing.png", "/apiary"])(
    "falls back to index.html for %s",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe(INDEX);
    },
  );

  it.each([
    ["/assets/index-B1a2c3d4.js", "text/javascript; charset=utf-8", "console.log('app');"],
    ["/assets/index-E5f6a7b8.css", "text/css; charset=utf-8", "body{margin:0}"],
    ["/assets/inter-C9d0e1f2.woff2", "font/woff2", "font"],
  ])("serves the hashed file %s with a long cache life", async (path, type, content) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("cache-control")).toBe(FOREVER);
    expect(response.headers.get("content-length")).toBe(String(content.length));
    expect(await response.text()).toBe(content);
  });

  it.each([
    ["/sw.js", "text/javascript; charset=utf-8"],
    ["/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    ["/index.html", "text/html; charset=utf-8"],
  ])("serves %s with no-cache", async (path, type) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves pictures outside the hashed folder with a short cache life", async () => {
    const response = await get("/icons/icon-192.png");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("answers 404, not the page, for a hashed file that is gone", async () => {
    const response = await get("/assets/index-00000000.js");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("<html");
  });

  it("does not answer /api paths with the page", async () => {
    for (const path of ["/api", "/api/", "/api/nothing"]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });

  it("answers HEAD without a body", async () => {
    const response = await get("/assets/index-B1a2c3d4.js", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("19");
    expect(await response.text()).toBe("");
  });

  it("answers 304 when the browser already has the file", async () => {
    const first = await get("/");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await get("/", { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("no-cache");
    expect(await second.text()).toBe("");
  });

  it.each([
    "/../outside.txt",
    "/..%2foutside.txt",
    "/%2e%2e/outside.txt",
    "/assets/..%2f..%2foutside.txt",
    "/assets/%2e%2e%2f%2e%2e%2foutside.txt",
    "/..%5coutside.txt",
    "//outside.txt",
    "/.secret",
    "/%2esecret",
    "/icons/%00",
    "/%E0%A4%A",
  ])("never serves anything outside the folder or hidden: %s", async (path) => {
    const response = await get(path);
    const text = await response.text();
    expect(text).not.toContain("outside the web folder");
    expect(text).not.toBe("hidden");
    expect([200, 404]).toContain(response.status);
    if (response.status === 200) expect(text).toBe(INDEX);
  });

  it("does not serve a folder", async () => {
    const response = await get("/icons");
    expect(await response.text()).toBe(INDEX);
  });
});

describe("when the web app has not been built", () => {
  it.each(["/", "/apps"])("says so on %s instead of failing", async (path) => {
    const { app, errors } = testApp({ config: testConfig({ webDist: join(parent, "no-such") }) });
    const response = await app.request(`${BASE}${path}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain("has not been built");
    expect(text).toContain("尚未构建");
    expect(errors).toEqual([]);
  });

  it("says so when the folder is there but empty", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hearth-empty-"));
    const response = await appWith(empty).request(`${BASE}/`);
    expect(response.status).toBe(503);
    rmSync(empty, { recursive: true, force: true });
  });

  it("still answers the API", async () => {
    const response = await appWith(join(parent, "no-such")).request(`${BASE}/api/health`);
    expect(response.status).toBe(200);
  });

  it("picks the web app up once it is built, without a restart", async () => {
    const late = mkdtempSync(join(tmpdir(), "hearth-late-"));
    const app = appWith(join(late, "dist"));
    expect((await app.request(`${BASE}/`)).status).toBe(503);
    mkdirSync(join(late, "dist"));
    writeFileSync(join(late, "dist", "index.html"), INDEX);
    expect((await app.request(`${BASE}/`)).status).toBe(200);
    rmSync(late, { recursive: true, force: true });
  });
});

describe("cacheControlFor", () => {
  it.each([
    ["/assets/index-B1a2c3d4.js", FOREVER],
    ["/index.html", "no-cache"],
    ["/sw.js", "no-cache"],
    ["/service-worker.js", "no-cache"],
    ["/manifest.webmanifest", "no-cache"],
    ["/manifest.json", "no-cache"],
    ["/theme-init.js", "no-cache"],
    ["/robots.txt", "no-cache"],
    ["/favicon.svg", "public, max-age=3600"],
    ["/icons/icon-192.PNG", "public, max-age=3600"],
  ])("%s -> %s", (path, value) => expect(cacheControlFor(path)).toBe(value));
});

describe("resolveInside", () => {
  it("keeps paths inside the root", () => {
    expect(resolveInside("/srv/web", "/assets/app.js")).toBe("/srv/web/assets/app.js");
    expect(resolveInside("/srv/web", "/a/../../etc/passwd")).toBeNull();
    expect(resolveInside("/srv/web", "/%2e%2e%2fweb-private/x")).toBeNull();
    expect(resolveInside("/srv/web", "/.env")).toBeNull();
  });
});
