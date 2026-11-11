/**
 * The web app against the real server (see playwright.config.ts for how it is started).
 * Everything else in this folder answers /api itself; these few tests check that
 * the two halves really fit: the session, saving preferences, the security
 * headers the server sends, the routes for apps as the built server answers
 * them, the sample apps the build was given (packages/fixture-apps), and the
 * screen for someone who was not invited.
 */
import { expect, test, type Page } from "@playwright/test";
import { GUEST_URL, OWNER_EMAIL, SERVER_VERSION } from "./servers.ts";

// The tests share one person's saved preferences, so they run in order.
test.describe.configure({ mode: "serial" });

/** Collects script errors and anything the browser refused because of the Content-Security-Policy. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

async function savePreferences(page: Page, action: () => Promise<void>): Promise<void> {
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/me") && response.request().method() === "PATCH");
  await action();
  expect((await saved).status()).toBe(200);
}

test("the owner gets the shell, with nothing blocked by the server's security headers", async ({ page }) => {
  const problems = watchForProblems(page);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No widgets yet" })).toBeVisible();
  // The script that sets the theme before first paint ran, despite inline scripts being forbidden.
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);

  await page.getByRole("link", { name: "Settings" }).click();
  const account = page.locator("section", { has: page.getByRole("heading", { name: "Account" }) });
  await expect(account.getByText(OWNER_EMAIL).first()).toBeVisible();
  await expect(account.getByTestId("build-version")).toHaveText(SERVER_VERSION);

  // A reload on a client-side address is answered with the app, not a 404.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("theme, language and name are stored by the server, not just by the browser", async ({ page }) => {
  await page.goto("/settings");
  const theme = () => page.getByRole("group", { name: /^(Theme|主题)$/ });
  const language = () => page.getByRole("group", { name: /^(Language|语言)$/ });

  await savePreferences(page, () => theme().getByRole("button", { name: /^(Dark|深色)$/ }).click());
  await savePreferences(page, () => language().getByRole("button", { name: "中文" }).click());
  const name = page.getByLabel("名字");
  await name.fill("Sam Example");
  await savePreferences(page, () => name.press("Enter"));

  // Forget everything this browser remembered: what comes back now comes from the server.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByLabel("名字")).toHaveValue("Sam Example");

  // Put things back for whoever runs next against the same server.
  await savePreferences(page, () => language().getByRole("button", { name: "English" }).click());
  await savePreferences(page, () => theme().getByRole("button", { name: "System" }).click());
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("someone who was never invited gets the not-a-member screen", async ({ page }) => {
  const session = page.waitForResponse((response) => response.url().endsWith("/api/session"));
  await page.goto(GUEST_URL);
  expect((await session).status()).toBe(403);
  await expect(page.getByRole("heading", { level: 1, name: "You are not a member yet" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
});

test("the built server answers the routes for apps in a space, with 404 for an app it does not hold", async ({ request }) => {
  const session = (await (await request.get("/api/session")).json()) as { spaces: { id: string; kind: string }[] };
  const personal = session.spaces.find((space) => space.kind === "personal");
  expect(personal).toBeDefined();
  const address = `/api/spaces/${personal?.id}/apps/no-such-app`;

  // The route is there: it reads the request before it looks for the app.
  const malformed = await request.put(address, { data: { memberAccess: "admin" } });
  expect(malformed.status()).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });

  // The server holds no app of this name, so there is nothing to add or to remove.
  for (const response of [await request.put(address, { data: {} }), await request.delete(address)]) {
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  }

  // An app's own queries and mutations have their routes as well, and answer likewise.
  for (const call of [`${address}/q/list`, `${address}/m/add`]) {
    const outsideEnvelope = await request.post(call, { data: { name: "Milk" } });
    expect(outsideEnvelope.status()).toBe(400);
    expect(await outsideEnvelope.json()).toMatchObject({ error: { code: "invalid_request" } });

    const nothingThere = await request.post(call, { data: { input: { name: "Milk" } } });
    expect(nothingThere.status()).toBe(404);
    expect(await nothingThere.json()).toMatchObject({ error: { code: "not_found" } });
  }

  // So have an app's settings: read, and saved in two groups.
  const misshapen = await request.patch(`${address}/settings`, { data: { everyone: { title: "Ours" } } });
  expect(misshapen.status()).toBe(400);
  expect(await misshapen.json()).toMatchObject({ error: { code: "invalid_request" } });
  for (const response of [
    await request.get(`${address}/settings`),
    await request.patch(`${address}/settings`, { data: { space: { title: "Ours" }, user: { compact: true } } }),
  ]) {
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  }
});

test("the build holds the sample apps: each can be added to a space, used in its widget and on its page, and removed", async ({
  page,
  request,
}) => {
  type Listed = { id: string; spaceId: string; name: { en: string; zh: string }; widgetSize: string; hasPage: boolean };
  type Item = { id: string; name: string; section: string; done: boolean };
  const sessionNow = async () =>
    (await (await request.get("/api/session")).json()) as { spaces: { id: string; kind: string }[]; apps: Listed[] };
  const personal = (await sessionNow()).spaces.find((space) => space.kind === "personal");
  expect(personal).toBeDefined();
  const checklist = `/api/spaces/${personal?.id}/apps/checklist`;
  const feed = `/api/spaces/${personal?.id}/apps/feed`;
  const listItems = async () =>
    ((await (await request.post(`${checklist}/q/list`, { data: {} })).json()) as { output: Item[] }).output;
  const problems = watchForProblems(page);

  try {
    // Adding an app the server holds is a saved setting: no rebuild, no restart.
    expect((await request.put(checklist, { data: {} })).status()).toBe(204);
    expect((await request.put(feed, { data: {} })).status()).toBe(204);

    // The session describes each from its manifest, which the build read from the app's folder.
    const listed = (await sessionNow()).apps.map((app) => [app.id, app.name.en, app.name.zh, app.widgetSize, app.hasPage]);
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual(["checklist", "Checklist", "清单", "tall", true]);
    expect(listed).toContainEqual(["feed", "Feed", "动态", "wide", false]);

    // Removing an app keeps its rows, so an earlier run against the same server may have left some: start empty.
    for (const item of await listItems()) {
      if (!item.done) await request.post(`${checklist}/m/tick`, { data: { input: { id: item.id, done: true } } });
    }
    expect((await request.post(`${checklist}/m/clearTicked`, { data: {} })).status()).toBe(200);

    // The checklist's server file was built in: its mutation writes, its query reads.
    const name = `Water the plants ${Date.now()}`;
    const added = await request.post(`${checklist}/m/add`, { data: { input: { name } } });
    expect(added.status()).toBe(200);
    expect(await listItems()).toEqual([expect.objectContaining({ name, section: "", done: false })]);

    // The feed has no server file, so nothing to call; its settings come from its manifest.
    expect((await request.post(`${feed}/q/list`, { data: {} })).status()).toBe(404);
    expect(await (await request.get(`${feed}/settings`)).json()).toEqual({ space: {}, user: { topics: [], period: "day" } });

    // The dashboard draws each app's own widget, fetched from the server's own origin,
    // which is all the Content-Security-Policy allows.
    await page.goto("/");
    const grid = page.getByTestId("widget-grid");
    const card = (title: string) => grid.locator("section", { has: page.getByRole("heading", { level: 2, name: title }) });
    await expect(card("Feed").getByText("Following every topic")).toBeVisible();
    const box = card("Checklist").getByRole("checkbox", { name });
    await expect(box).not.toBeChecked();
    await expect(card("Checklist").getByText("1 left")).toBeVisible();

    // The widgets' own classes reached the stylesheet, although no file of the web app uses them.
    const minHeight = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).minHeight);
    expect(await minHeight('[data-app-part="checklist"] > div')).toBe("88px");
    expect(await minHeight('[data-app-part="feed"] > div')).toBe("72px");

    // Ticking in the widget is saved by the server ...
    await box.click();
    await expect(card("Checklist").getByText("Nothing to do.")).toBeVisible();
    expect(await listItems()).toEqual([expect.objectContaining({ name, done: true })]);

    // ... and the app's page, drawn by its own page.tsx, shows it ticked.
    await card("Checklist").getByRole("link", { name: "Open Checklist" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Checklist" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("checkbox", { name })).toBeChecked();
    // A reload on the page's address is answered with the app, and the page comes back.
    await page.reload();
    await expect(page.getByRole("main").getByRole("checkbox", { name })).toBeChecked();
    expect(problems).toEqual([]);
  } finally {
    // Removing keeps the data; it leaves the dashboard empty for whoever runs next.
    await request.delete(checklist);
    await request.delete(feed);
  }
  expect((await sessionNow()).apps).toEqual([]);
});

test("the web app carries each sample app's widget and page, and fetches them only when asked", async ({ page, request }) => {
  const problems = watchForProblems(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  // The entry script names one file for each app's widget, and one for the checklist's page.
  const entry = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(entry).toBeTruthy();
  const script = await (await request.get(entry ?? "")).text();
  expect(new Set(script.match(/\/widget-[\w-]+\.js/g)).size).toBe(2);
  expect(new Set(script.match(/\/page-[\w-]+\.js/g)).size).toBe(1);

  // A dashboard without widgets has fetched none of them.
  const fetched = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  expect(fetched.filter((url) => /\/assets\/(widget|page)-/.test(url))).toEqual([]);
  expect(problems).toEqual([]);
});

test.describe("installed", () => {
  test.use({ serviceWorkers: "allow" });

  test("the service worker installs from the real server and leaves /api alone", async ({ page }) => {
    const problems = watchForProblems(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });
    expect(cached).toContain("/");
    expect(cached.filter((url) => url.startsWith("/api"))).toEqual([]);
    // The widgets of the apps this build holds are part of the shell, so they work offline too.
    expect(cached.filter((url) => url.startsWith("/assets/widget-"))).toHaveLength(2);
    expect(cached.filter((url) => url.startsWith("/assets/page-"))).toHaveLength(1);

    const session = page.waitForResponse((response) => response.url().endsWith("/api/session"));
    await page.reload();
    expect((await session).fromServiceWorker()).toBe(false);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect(problems).toEqual([]);
  });
});
