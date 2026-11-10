import { expect, test } from "./fixtures.ts";

test("the page links an installable manifest that is fetched with credentials", async ({ page, api, request }) => {
  void api;
  await page.goto("/");
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveAttribute("crossorigin", "use-credentials");
  const href = await link.getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");

  const manifest = await (await request.get(href ?? "")).json();
  expect(manifest.name).toBe("Hearth");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);

  const icons: Array<{ src: string; sizes: string; type: string; purpose: string }> = manifest.icons;
  expect(icons.map((icon) => icon.type).sort()).toEqual(["image/png", "image/png", "image/png", "image/svg+xml"]);
  expect(icons.some((icon) => icon.sizes === "192x192")).toBe(true);
  expect(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);
  for (const icon of icons) {
    const response = await request.get(icon.src);
    expect(response.status(), icon.src).toBe(200);
    expect(response.headers()["content-type"], icon.src).toContain(icon.type);
  }
  expect((await request.get("/icons/apple-touch-icon.png")).status()).toBe(200);
});

test.describe("service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("caches the static shell and nothing from /api, and the shell opens offline", async ({ page, api, context }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

    // Installed, active and in control of the page.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
      }
    });

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      }
      return { names, urls };
    });
    expect(cached.names).toHaveLength(1);
    expect(cached.names[0]).toMatch(/^hearth-shell-[0-9a-f]{12}$/);
    expect(cached.urls).toContain("/");
    expect(cached.urls).toContain("/manifest.webmanifest");
    expect(cached.urls.some((url) => /^\/assets\/index-.+\.js$/.test(url))).toBe(true);
    expect(cached.urls.some((url) => /^\/assets\/index-.+\.css$/.test(url))).toBe(true);
    expect(cached.urls.filter((url) => url.startsWith("/api"))).toEqual([]);

    // The API is still asked every time: the worker never answers for it.
    const before = api.sessionRequests;
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect(api.sessionRequests).toBe(before + 1);
    expect(await page.evaluate(() => caches.keys().then((names) => names.length))).toBe(1);

    // With the network gone the shell still opens, and says plainly that the server cannot be reached.
    await page.unroute("**/api/**");
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Hearth could not load" })).toBeVisible();
    await expect(page.getByText("The server could not be reached.")).toBeVisible();
    await context.setOffline(false);
  });
});
