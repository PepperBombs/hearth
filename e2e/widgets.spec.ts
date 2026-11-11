/**
 * Widgets and pages of mini-apps in the shell. The tested build holds the
 * framework's two sample apps (packages/fixture-apps); the stand-in server
 * of ./fixtures.ts answers their routes, so each test decides what the
 * server says and when.
 */
import type { Page } from "@playwright/test";
import { FAMILY_SPACE, PERSONAL_SPACE, PHONE, expect, sessionWithApps, sessionWithSampleApps, test } from "./fixtures.ts";

const card = (page: Page, name: string) =>
  page.getByTestId("widget-grid").locator("section", { has: page.getByRole("heading", { level: 2, name, exact: true }) });

test.describe("widgets on the dashboard", () => {
  test("each app's own widget is drawn in its card, after a skeleton", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    const release = api.holdApps();
    await page.goto("/");

    const checklist = card(page, "Checklist");
    const feed = card(page, "Feed");
    // The frame is there at once; the inside waits for the app's code and its first answers.
    await expect(checklist.getByText("Family", { exact: true })).toBeVisible();
    await expect(checklist.getByRole("link", { name: "Open Checklist in Family" })).toBeVisible();
    await expect(checklist.getByTestId("app-skeleton")).toBeVisible();
    await expect(feed.getByTestId("app-skeleton")).toBeVisible();
    await expect(checklist.getByRole("checkbox")).toHaveCount(0);

    release();
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);
    await expect(checklist.getByRole("checkbox", { name: "Water the plants" })).not.toBeChecked();
    await expect(checklist.getByText("2 left")).toBeVisible();
    await expect(feed.getByText("Following every topic")).toBeVisible();
    await expect(page.getByTestId("app-skeleton")).toHaveCount(0);
    // An app without a page has no link to one.
    await expect(feed.getByRole("link")).toHaveCount(0);
  });

  test("a card takes the room its app asked for: two rows, or two columns", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const span = (name: string) =>
      card(page, name).evaluate((el) => {
        const style = getComputedStyle(el);
        // A card without a span of its own takes one cell.
        return [style.gridColumnEnd, style.gridRowEnd].map((end) => (end === "auto" ? "span 1" : end));
      });
    await expect(card(page, "Feed").getByText("Following every topic")).toBeVisible();
    expect(await span("Checklist")).toEqual(["span 1", "span 2"]);
    expect(await span("Feed")).toEqual(["span 2", "span 1"]);
    const tall = (await card(page, "Checklist").boundingBox())!;
    const wide = (await card(page, "Feed").boundingBox())!;
    expect(tall.height).toBeGreaterThan(wide.height * 1.9);
    expect(wide.width).toBeGreaterThan(tall.width * 1.9);

    // In a single column every card is one cell.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => span("Checklist")).toEqual(["span 1", "span 1"]);
    await expect.poll(() => span("Feed")).toEqual(["span 1", "span 1"]);
  });

  test("ticking an item in the widget saves it, and the app's page shows it ticked", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const checklist = card(page, "Checklist");

    await checklist.getByRole("checkbox", { name: "Water the plants" }).click();
    await expect(checklist.getByRole("checkbox")).toHaveCount(1);
    await expect(checklist.getByText("1 left")).toBeVisible();
    expect(api.items.find((item) => item.name === "Water the plants")?.done).toBe(true);
    expect(api.appRequests).toContain(`POST /api/spaces/${FAMILY_SPACE}/apps/checklist/m/tick`);

    await checklist.getByRole("link", { name: "Open Checklist in Family" }).click();
    await expect(page).toHaveURL(new RegExp(`/apps/${FAMILY_SPACE}/checklist$`));
    await expect(page.getByRole("heading", { level: 1, name: "Checklist" })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main.getByRole("checkbox", { name: "Water the plants" })).toBeChecked();
    await expect(main.getByRole("checkbox", { name: "Book the dentist" })).not.toBeChecked();
    // The session was loaded once: moving between the dashboard and a page reloads nothing.
    expect(api.sessionRequests).toBe(1);
  });

  test("the page adds an item, which the widget then lists", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto(`/apps/${FAMILY_SPACE}/checklist`);
    const main = page.getByRole("main");
    await main.getByRole("textbox", { name: "Add an item" }).fill("Feed the cat");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    await expect(main.getByRole("checkbox", { name: "Feed the cat" })).toBeVisible();
    await expect(main.getByRole("textbox", { name: "Add an item" })).toHaveValue("");

    await main.getByRole("button", { name: "Clear ticked" }).click();
    await expect(main.getByRole("checkbox", { name: "Return the library books" })).toHaveCount(0);

    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Dashboard" }).click();
    await expect(card(page, "Checklist").getByRole("checkbox")).toHaveText(["", "", ""]);
    await expect(card(page, "Checklist").getByText("Feed the cat")).toBeVisible();
    await expect(card(page, "Checklist").getByText("3 left")).toBeVisible();
  });

  test("someone who may only view sees the list and cannot tick", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps({}, { access: "view" }));
    await page.goto("/");
    await expect(card(page, "Checklist").getByRole("checkbox", { name: "Water the plants" })).toBeDisabled();
    await page.goto(`/apps/${FAMILY_SPACE}/checklist`);
    await expect(page.getByRole("main").getByRole("checkbox", { name: "Water the plants" })).toBeDisabled();
    await expect(page.getByRole("main").getByRole("textbox")).toHaveCount(0);
  });

  test("widgets speak Chinese to someone who reads Chinese", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps({ locale: "zh" }));
    api.appSettings.feed = { space: {}, user: { topics: ["food", "sport"], period: "week" } };
    await page.goto("/");
    await expect(card(page, "清单").getByText("还剩 2 项")).toBeVisible();
    await expect(card(page, "清单").getByRole("link", { name: "打开 Family的清单" })).toBeVisible();
    await expect(card(page, "动态").getByText("关注了 2 个主题")).toBeVisible();
  });

  test("another person's change appears within 15 seconds, and at once when the window is looked at again", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.clock.install({ time: new Date("2026-11-10T09:00:00Z") });
    await page.goto("/");
    const checklist = card(page, "Checklist");
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);
    const readings = () => api.appRequestCount("/q/list");
    expect(readings()).toBe(1);

    // Lin, at another screen, ticks one item and adds another. Nothing tells this page.
    api.items[0]!.done = true;
    api.items.push({ ...api.items[0]!, id: "item-9", name: "Buy stamps", done: false });
    await page.clock.runFor(10_000);
    expect(readings()).toBe(1);
    await page.clock.runFor(6_000);
    await expect(checklist.getByText("Buy stamps")).toBeVisible();
    await expect(checklist.getByText("Water the plants")).toHaveCount(0);
    expect(readings()).toBe(2);

    // A hidden window asks nothing. Shown again, it asks straight away.
    const setVisibility = (state: "hidden" | "visible") =>
      page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        window.dispatchEvent(new Event("visibilitychange"));
      }, state);
    await setVisibility("hidden");
    api.items.push({ ...api.items[0]!, id: "item-10", name: "Call the plumber", done: false });
    await page.clock.runFor(60_000);
    expect(readings()).toBe(2);
    await setVisibility("visible");
    await expect(checklist.getByText("Call the plumber")).toBeVisible();
    expect(readings()).toBe(3);
  });

  test("a widget that cannot be loaded says so in its card, and loads on another try", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    api.appFailure = { status: 500, code: "internal", message: "Sample failure" };
    await page.goto("/");
    const checklist = card(page, "Checklist");
    await expect(checklist.getByRole("alert")).toHaveText(/This app could not be loaded\./);
    await expect(checklist.getByRole("link", { name: "Open Checklist in Family" })).toBeVisible();
    await expect(card(page, "Feed").getByRole("alert")).toBeVisible();

    api.appFailure = null;
    await checklist.getByRole("button", { name: "Try again" }).click();
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);
    await expect(checklist.getByRole("alert")).toHaveCount(0);
    // The other card is its own: it stays as it was until it is tried again too.
    await expect(card(page, "Feed").getByRole("alert")).toBeVisible();
  });

  test("a change that cannot be saved is reported under the widget", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const checklist = card(page, "Checklist");
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);

    api.appFailure = { status: 500, code: "internal", message: "Sample failure" };
    await checklist.getByRole("checkbox", { name: "Water the plants" }).click();
    await expect(checklist.getByText("That change could not be saved. Try again.")).toBeVisible();
    // Nothing was ticked, here or on the server.
    await expect(checklist.getByRole("checkbox", { name: "Water the plants" })).not.toBeChecked();
    expect(api.items[0]?.done).toBe(false);

    api.appFailure = null;
    await checklist.getByRole("checkbox", { name: "Water the plants" }).click();
    await expect(checklist.getByRole("checkbox")).toHaveCount(1);
    await expect(checklist.getByText("That change could not be saved. Try again.")).toHaveCount(0);
  });

  test("a change the server turns down reads the app again, and does not ask to try again", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const checklist = card(page, "Checklist");
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);
    const reads = api.appRequestCount("/q/list");

    // Someone else cleared the item a moment ago: ticking it finds nothing.
    api.items = api.items.filter((item) => item.name !== "Water the plants");
    await checklist.getByRole("checkbox", { name: "Water the plants" }).click();
    await expect(checklist.getByText("That change was not made. The app now shows what is saved.")).toBeVisible();
    await expect(checklist.getByRole("checkbox")).toHaveCount(1);
    await expect(checklist.getByText("1 left")).toBeVisible();
    expect(api.appRequestCount("/q/list")).toBe(reads + 1);
    await expect(checklist.getByText(/Try again/)).toHaveCount(0);
  });

  test("a long word or link in an item wraps inside its card", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    const link = `https://example.com/shopping/list/${"a".repeat(60)}`;
    api.items = [{ ...api.items[0]!, name: link }];
    await page.goto("/");
    const checklist = card(page, "Checklist");
    const label = checklist.getByText(link);
    await expect(label).toBeVisible();
    const inside = (await checklist.boundingBox())!;
    const text = (await label.boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(inside.x + inside.width);
    expect(await checklist.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    await page.goto(`/apps/${FAMILY_SPACE}/checklist`);
    const main = page.getByRole("main");
    await expect(main.getByText(link)).toBeVisible();
    expect(await main.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test("the same app in two spaces gets cards and links a screen reader can tell apart", async ({ page, api }) => {
    const session = sessionWithSampleApps();
    const family = session.apps.find((app) => app.id === "checklist")!;
    api.setSession({ ...session, apps: [...session.apps, { ...family, spaceId: PERSONAL_SPACE }] });
    await page.goto("/");
    const grid = page.getByTestId("widget-grid");
    await expect(grid.getByRole("region", { name: "Checklist", exact: true })).toBeVisible();
    await expect(grid.getByRole("region", { name: "Checklist in Family", exact: true })).toBeVisible();
    await expect(grid.getByRole("link", { name: "Open Checklist", exact: true })).toHaveAttribute("href", `/apps/${PERSONAL_SPACE}/checklist`);
    await expect(grid.getByRole("link", { name: "Open Checklist in Family", exact: true })).toHaveAttribute(
      "href",
      `/apps/${FAMILY_SPACE}/checklist`,
    );
  });

  test("an app that was taken away disappears: a not_found from its routes loads the session again", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const checklist = card(page, "Checklist");
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);
    expect(api.sessionRequests).toBe(1);

    // An owner removes the checklist from the family space while this page is open.
    const session = sessionWithSampleApps();
    api.setSession({ ...session, apps: session.apps.filter((app) => app.id !== "checklist") });
    await checklist.getByRole("checkbox", { name: "Water the plants" }).click();

    await expect(checklist).toHaveCount(0);
    await expect(card(page, "Feed").getByText("Following every topic")).toBeVisible();
    expect(api.sessionRequests).toBe(2);
    // Nothing was written anywhere.
    expect(api.items[0]?.done).toBe(false);
    // The app's page is gone with it.
    await page.goto(`/apps/${FAMILY_SPACE}/checklist`);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  });

  test("an app this build does not hold gets a card that says: reload to update", async ({ page, api }) => {
    // The server lists apps that were built in after this browser fetched its copy of Hearth.
    api.setSession(sessionWithApps());
    await page.goto("/");
    const grocery = card(page, "Grocery");
    await expect(grocery.getByText("Hearth has been updated since you opened this page.")).toBeVisible();
    await expect(grocery.getByText("Family", { exact: true })).toBeVisible();
    // No request is made for an app whose code is not here.
    expect(api.appRequests).toEqual([]);

    await grocery.getByRole("button", { name: "Reload to update" }).click();
    await expect.poll(() => api.sessionRequests).toBe(2);
    await expect(card(page, "Grocery").getByRole("button", { name: "Reload to update" })).toBeVisible();

    // Its page says the same.
    await page.goto(`/apps/${FAMILY_SPACE}/grocery`);
    await expect(page.getByRole("heading", { level: 1, name: "Grocery" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Reload to update" })).toBeVisible();
  });
});

test.describe("widgets on a phone", () => {
  test.use(PHONE);

  test("stack in one column, with boxes big enough for a finger", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const checklist = card(page, "Checklist");
    const feed = card(page, "Feed");
    await expect(checklist.getByRole("checkbox")).toHaveCount(2);
    const a = (await checklist.boundingBox())!;
    const b = (await feed.boundingBox())!;
    expect(a.width).toBe(b.width);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);

    const row = (await checklist.getByRole("listitem").first().boundingBox())!;
    expect(row.height).toBeGreaterThanOrEqual(44);
    await checklist.getByText("Book the dentist").tap();
    await expect(checklist.getByRole("checkbox")).toHaveCount(1);
  });

  test("an app's page in a group names the group in the top bar", async ({ page, api }) => {
    api.setSession(sessionWithSampleApps());
    await page.goto(`/apps/${FAMILY_SPACE}/checklist`);
    const bar = page.locator("header");
    await expect(bar.getByRole("heading", { level: 1, name: "Checklist" })).toBeVisible();
    await expect(bar.getByText("Family", { exact: true })).toBeVisible();
  });
});
