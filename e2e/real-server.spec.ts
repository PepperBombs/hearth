/**
 * The web app against the real server (see playwright.config.ts for how it is started).
 * Everything else in this folder answers /api itself; these few tests check that
 * the two halves really fit: the session, saving preferences, the security
 * headers the server sends, the routes for apps as the built server answers
 * them, the screen for someone who was not invited, and the built-in apps the
 * server ships (docs/platform.md), whose pages run in the sandbox: added to a
 * space from the Add dialog or brought back, used in their cards and on their
 * pages, pinned, given settings in both languages and switched off. Then a
 * family of two people: the owner and Lin, each with a copy of the server of
 * their own over one database, who share a group and its apps, one of which
 * the owner moves out of it and back, and GitHub Trending, whose page fetches
 * from GitHub through the server: here from a file of stand-in answers both
 * copies read.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PHONE, expectNothingPastTheEdge, sandbox } from "./fixtures.ts";
import { GUEST_URL, MEMBER_EMAIL, MEMBER_URL, OWNER_EMAIL, SERVER_VERSION, writeStandIns } from "./servers.ts";

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

/** What the tests read of a session. */
type SessionNow = {
  user: { id: string };
  spaces: { id: string; kind: string; name: string; role: string }[];
  apps: { id: string; spaceId: string; template?: string; access: string; enabled: boolean; pinned: boolean }[];
};

/** Someone's session as the server gives it now: the owner's through `request`, Lin's through a request context of her own. */
async function sessionOf(api: APIRequestContext): Promise<SessionNow> {
  return (await (await api.get("/api/session")).json()) as SessionNow;
}

/** The ID the session gives the app added to a space from a built-in app, or "" when it lists none. */
function addedFrom(session: SessionNow, spaceId: string, template: string): string {
  return session.apps.find((app) => app.spaceId === spaceId && app.template === template)?.id ?? "";
}

/** The rows of one collection of a made app in a space, oldest first, as `api` may read them. */
async function rowsOf(api: APIRequestContext, spaceId: string, appId: string, collection: string): Promise<Record<string, unknown>[]> {
  const answer = await api.get(`/api/spaces/${spaceId}/apps/${appId}/rows/${collection}?orderBy=createdAt`);
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { rows: Record<string, unknown>[] }).rows;
}

/**
 * Deletes for good what an earlier run against the same server left of a
 * built-in app in a space: removing an app keeps its data, and adding it
 * again would bring that back.
 */
async function forgetBuiltIn(api: APIRequestContext, spaceId: string, template: string): Promise<void> {
  const list = (await (await api.get(`/api/spaces/${spaceId}/apps`)).json()) as { apps: { id: string; template?: string; removedAt: string | null }[] };
  for (const entry of list.apps.filter((app) => app.template === template)) {
    if (entry.removedAt === null) expect((await api.delete(`/api/spaces/${spaceId}/apps/${entry.id}`)).status()).toBe(204);
    expect((await api.delete(`/api/spaces/${spaceId}/apps/${entry.id}/data`, { data: { confirm: entry.id } })).status()).toBe(204);
  }
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
  const personal = (await sessionOf(request)).spaces.find((space) => space.kind === "personal");
  expect(personal).toBeDefined();
  const address = `/api/spaces/${personal?.id}/apps/no-such-app`;

  // The route is there: it reads the request before it looks for the app.
  const malformed = await request.put(address, { data: { memberAccess: "admin" } });
  expect(malformed.status()).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });

  // The server holds no app of this name, so there is nothing to bring back or to remove.
  for (const response of [await request.put(address, { data: {} }), await request.delete(address)]) {
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  }

  // An app's page and its rows, which every app made in Hearth has, answer likewise.
  const outsideEnvelope = await request.post(`${address}/rows/items`, { data: { name: "Milk" } });
  expect(outsideEnvelope.status()).toBe(400);
  expect(await outsideEnvelope.json()).toMatchObject({ error: { code: "invalid_request" } });
  for (const response of [
    await request.get(`${address}/frame`),
    await request.get(`${address}/rows/items`),
    await request.post(`${address}/rows/items`, { data: { data: { name: "Milk" } } }),
  ]) {
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
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

  // The built-in apps, for the Add dialog, each with the hosts it fetches from; one the server does not ship is not there to add.
  const catalog = (await (await request.get("/api/catalog")).json()) as { id: string; name: { en: string; zh: string }; network: string[] }[];
  expect(catalog.map((app) => [app.id, app.name.en, app.name.zh, app.network])).toEqual([
    ["grocery", "Grocery list", "购物清单", []],
    ["ideas", "Ideas", "想法", []],
    ["trending", "GitHub Trending", "GitHub 热门", ["api.github.com"]],
  ]);
  const misread = await request.post(`/api/spaces/${personal?.id}/catalog/grocery`, { data: { memberAccess: "admin" } });
  expect(misread.status()).toBe(400);
  const unknown = await request.post(`/api/spaces/${personal?.id}/catalog/no-such-app`, { data: {} });
  expect(unknown.status()).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
});

test("the owner moves a group's grocery list into their own space and back: its data goes along, access starts afresh", async ({
  page,
  request,
  playwright,
}) => {
  const owner = await sessionOf(request);
  const personalId = owner.spaces.find((space) => space.kind === "personal")?.id ?? "";
  // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
  const groupName = `Movers ${Date.now().toString(36)}`;
  const ownItem = `Sample from the owner ${Date.now()}`;
  const linItem = `Sample from Lin ${Date.now()}`;
  const problems = watchForProblems(page);
  const card = (name: string) => page.getByRole("main").getByRole("region", { name });
  const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
  /** Who wrote each item of the list, as `api` reads them. */
  const itemsAt = async (api: APIRequestContext, spaceId: string) =>
    (await rowsOf(api, spaceId, appId, "items")).map((item) => [item.name, item.createdBy]);
  let groupId = "";
  let appId = "";

  try {
    // A group of the owner and Lin, with the grocery list for both to change, an item from each,
    // the aisles everyone shares, and each one's own setting and pin.
    const created = await request.post("/api/spaces", { data: { name: groupName } });
    expect(created.status()).toBe(201);
    groupId = ((await created.json()) as { id: string }).id;
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
    // Her first request makes an invited Lin arrive; on a server she already uses, she was added at once.
    const lin = (await sessionOf(linApi)).user;
    const added = await request.post(`/api/spaces/${groupId}/catalog/grocery`, { data: { memberAccess: "edit" } });
    expect(added.status()).toBe(201);
    appId = ((await added.json()) as { appId: string }).appId;
    const inGroup = `/api/spaces/${groupId}/apps/${appId}`;
    const inPersonal = `/api/spaces/${personalId}/apps/${appId}`;
    expect((await request.post(`${inGroup}/rows/items`, { data: { data: { name: ownItem, aisle: "", done: false } } })).status()).toBe(201);
    expect((await linApi.post(`${inGroup}/rows/items`, { data: { data: { name: linItem, aisle: "", done: false } } })).status()).toBe(201);
    expect((await request.patch(`${inGroup}/settings`, { data: { space: { aisles: ["Garden"] }, user: { hideDone: true } } })).status()).toBe(200);
    expect((await linApi.patch(`${inGroup}/settings`, { data: { user: { hideDone: true } } })).status()).toBe(200);
    expect((await request.patch(`${inGroup}/me`, { data: { pinned: true } })).status()).toBe(204);
    expect((await linApi.patch(`${inGroup}/me`, { data: { pinned: true } })).status()).toBe(204);

    // The owner moves it on the Apps page into their own space.
    await page.goto("/apps");
    await card(groupName).getByRole("button", { name: `Move Grocery list in ${groupName}`, exact: true }).click();
    let dialog = page.getByRole("dialog", { name: `Move Grocery list in ${groupName} to another space` });
    await dialog.getByRole("radio", { name: /Personal/ }).check();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(card("Personal").getByText("Grocery list was moved here.")).toBeFocused();

    // Both items arrived, each still by whoever wrote it, with the aisles and the owner's own pin and setting.
    expect(await itemsAt(request, personalId)).toEqual(
      expect.arrayContaining([
        [ownItem, owner.user.id],
        [linItem, lin.id],
      ]),
    );
    expect(await itemsAt(request, personalId)).toHaveLength(2);
    expect(await (await request.get(`${inPersonal}/settings`)).json()).toEqual({ space: { aisles: ["Garden"] }, user: { hideDone: true } });
    expect((await sessionOf(request)).apps).toEqual([expect.objectContaining({ id: appId, spaceId: personalId, access: "edit", pinned: true })]);
    // Lin is not in the owner's own space: the app is gone for her, at the old address and the new one.
    expect((await sessionOf(linApi)).apps.filter((app) => app.id === appId)).toEqual([]);
    expect((await linApi.get(`${inGroup}/rows/items`)).status()).toBe(404);
    expect((await linApi.get(`${inPersonal}/rows/items`)).status()).toBe(404);

    // Back into the group, for everyone to view.
    await card("Personal").getByRole("button", { name: "Move Grocery list", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Move Grocery list to another space" });
    await dialog.getByRole("radio", { name: new RegExp(groupName) }).check();
    await dialog.getByRole("radio", { name: "Everyone can view" }).check();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(card(groupName).getByText("Grocery list was moved here.")).toBeFocused();

    // Lin has it again, as everyone gets it now, and the data is all there; her own pin and setting
    // did not survive the time in a space she is not in, and her old edit access did not come back.
    expect((await sessionOf(linApi)).apps.filter((app) => app.id === appId)).toEqual([
      expect.objectContaining({ spaceId: groupId, access: "view", pinned: false }),
    ]);
    expect(await (await linApi.get(`${inGroup}/settings`)).json()).toEqual({ space: { aisles: ["Garden"] }, user: { hideDone: false } });
    expect(await itemsAt(linApi, groupId)).toEqual(
      expect.arrayContaining([
        [ownItem, owner.user.id],
        [linItem, lin.id],
      ]),
    );
    expect((await linApi.post(`${inGroup}/rows/items`, { data: { data: { name: "Sample not allowed", aisle: "", done: false } } })).status()).toBe(403);
    // The owner's own pin and setting made both trips.
    expect((await sessionOf(request)).apps).toEqual([expect.objectContaining({ id: appId, spaceId: groupId, pinned: true })]);
    expect(await (await request.get(`${inGroup}/settings`)).json()).toEqual({ space: { aisles: ["Garden"] }, user: { hideDone: true } });
    expect(problems).toEqual([]);
  } finally {
    // The group stays (nothing deletes a space); the app and Lin leave it, and the owner's
    // dashboard is empty again for whatever runs next against the same server.
    if (groupId) {
      if (appId) {
        await request.delete(`/api/spaces/${groupId}/apps/${appId}`);
        await request.delete(`/api/spaces/${personalId}/apps/${appId}`);
      }
      const lin = ((await (await linApi.get("/api/session")).json()) as { user?: { id: string } }).user;
      if (lin) await request.delete(`/api/spaces/${groupId}/members/${lin.id}`);
    }
    await linApi.dispose();
  }
  expect((await sessionOf(request)).apps).toEqual([]);
});

test.describe("built-in apps, whose pages run in the sandbox", () => {
  // Playwright blocks service workers with a script it runs in every frame, which reads
  // navigator.serviceWorker; a sandboxed frame refuses that, and the page would report an error
  // that is the test's own. With service workers allowed nothing is injected, so every error is real.
  test.use({ serviceWorkers: "allow" });

  test("each is added to a space from the Add dialog as an app of its own, used in its card and on its page, and removed", async ({
    page,
    request,
  }) => {
    const personalId = (await sessionOf(request)).spaces.find((space) => space.kind === "personal")?.id ?? "";
    const idea = `Water the ferns ${Date.now().toString(36)} #home`;
    const problems = watchForProblems(page);
    let appId = "";

    try {
      await forgetBuiltIn(request, personalId, "ideas");

      // Adding an app is a saved setting: no rebuild, no restart.
      await page.goto("/apps");
      const mine = page.getByRole("main").getByRole("region", { name: "Personal" });
      await mine.getByRole("button", { name: "Add an app" }).click();
      const add = page.getByRole("dialog", { name: "Add an app to your personal space" });
      await add.getByRole("radio", { name: /Ideas/ }).check();
      await add.getByRole("button", { name: "Add", exact: true }).click();
      await expect(add).toBeHidden();
      await expect(mine.getByRole("switch", { name: "Show Ideas" })).toBeChecked();

      // The session describes it from the built-in app's manifest, as an app made in Hearth of the space's own.
      appId = addedFrom(await sessionOf(request), personalId, "ideas");
      expect(appId).toMatch(/^m-[a-z0-9]{10}$/);
      expect((await sessionOf(request)).apps).toEqual([
        expect.objectContaining({
          id: appId,
          spaceId: personalId,
          name: { en: "Ideas", zh: "想法" },
          widgetSize: "tall",
          hasPage: true,
          made: true,
          template: "ideas",
          version: 1,
        }),
      ]);
      // It declares no settings, so it has none to read and its card offers none.
      expect(await (await request.get(`/api/spaces/${personalId}/apps/${appId}/settings`)).json()).toEqual({ space: {}, user: {} });

      // The dashboard draws its page in its card, in the sandbox, with the sandbox's own Content-Security-Policy.
      const frameAnswer = page.waitForResponse((response) => response.url().includes(`/apps/${appId}/frame`));
      await page.goto("/");
      const policy = (await frameAnswer).headers()["content-security-policy"] ?? "";
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("sandbox allow-scripts");
      const card = page.getByTestId("widget-grid").getByRole("region", { name: "Ideas", exact: true });
      await expect(card.getByRole("button", { name: "Settings of Ideas" })).toHaveCount(0);

      // An idea written in the card is kept by the server, with its #tag.
      const inCard = sandbox(page, appId);
      await inCard.getByLabel("Write an idea").fill(idea);
      await inCard.getByRole("button", { name: "Save" }).click();
      await expect(inCard.getByText(idea)).toBeVisible();
      expect(await rowsOf(request, personalId, appId, "ideas")).toEqual([
        expect.objectContaining({ text: idea, tags: ["home"], pinned: false, archived: false }),
      ]);

      // The app's page, the same app drawn whole, has it on its timeline, with its tag to pick.
      await card.getByRole("link", { name: "Open Ideas" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Ideas" })).toBeVisible();
      const timeline = sandbox(page, appId).getByRole("list", { name: "Active (1)" });
      await expect(timeline.getByText(idea.replace(" #home", ""))).toBeVisible();
      await expect(timeline.getByRole("button", { name: "#home" })).toBeVisible();
      // A reload on the page's address is answered with the app, and the page comes back.
      await page.reload();
      await expect(sandbox(page, appId).getByRole("list", { name: "Active (1)" }).getByRole("button", { name: "#home" })).toBeVisible();
      expect(problems).toEqual([]);
    } finally {
      // Removing keeps the data; it leaves the dashboard empty for whoever runs next.
      if (appId) await request.delete(`/api/spaces/${personalId}/apps/${appId}`);
    }
    expect((await sessionOf(request)).apps).toEqual([]);
  });

  test("on the Apps page a removed one is brought back without a rebuild, pinned, given settings in both languages and switched off", async ({
    page,
    request,
  }) => {
    const personalId = (await sessionOf(request)).spaces.find((space) => space.kind === "personal")?.id ?? "";
    const problems = watchForProblems(page);
    const spaceCard = (name: string) => page.getByRole("main").getByRole("region", { name });
    let appId = "";

    try {
      // An earlier test or run may have left the grocery list in the personal space, removed with its data kept,
      // or there; or never added it. Make sure it is removed: the dialog then says that adding it again brings that back.
      const added = await request.post(`/api/spaces/${personalId}/catalog/grocery`, { data: {} });
      expect([200, 201, 409]).toContain(added.status());
      appId = addedFrom(await sessionOf(request), personalId, "grocery");
      expect(appId).not.toBe("");
      expect((await request.delete(`/api/spaces/${personalId}/apps/${appId}`)).status()).toBe(204);
      const settingsNow = async () => (await (await request.get(`/api/spaces/${personalId}/apps/${appId}/settings`)).json()) as unknown;

      // Nothing is in the personal space now; the built-in apps are there to choose from.
      await page.goto("/apps");
      const mine = spaceCard("Personal");
      await mine.getByRole("button", { name: "Add an app" }).click();
      const add = page.getByRole("dialog", { name: "Add an app to your personal space" });
      await add.getByRole("radio", { name: /Grocery list/ }).check();
      const choice = add.locator("label", { has: page.getByRole("radio", { name: /Grocery list/ }) });
      await expect(choice.getByText(/^Removed earlier: adding it again brings back/)).toBeVisible();
      await add.getByRole("button", { name: "Bring back", exact: true }).click();
      await expect(add).toBeHidden();
      await expect(mine.getByRole("switch", { name: "Show Grocery list" })).toBeChecked();
      // The same app, with what it held.
      expect((await sessionOf(request)).apps).toEqual([expect.objectContaining({ id: appId, enabled: true })]);

      // Pinned: kept by the server, so a reload still shows it.
      await mine.getByRole("button", { name: "Pin Grocery list" }).click();
      await expect(page.getByRole("region", { name: "Pinned" }).getByRole("link", { name: "Grocery list" })).toBeVisible();
      await page.reload();
      await expect(mine.getByRole("button", { name: "Pin Grocery list" })).toHaveAttribute("aria-pressed", "true");
      expect((await sessionOf(request)).apps).toEqual([expect.objectContaining({ id: appId, pinned: true })]);

      // A setting of the space and one of this person's own, in English.
      await mine.getByRole("button", { name: "Settings of Grocery list" }).click();
      let dialog = page.getByRole("dialog", { name: "Grocery list settings" });
      await dialog.getByRole("textbox", { name: "New entry in Aisles" }).fill("Garden");
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await dialog.getByRole("switch", { name: "Hide ticked items" }).click();
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();
      expect(await settingsNow()).toEqual({ space: { aisles: ["Garden"] }, user: { hideDone: true } });

      // And in Chinese.
      await savePreferences(page, () => page.getByRole("button", { name: /Switch language/ }).click());
      await expect(page.getByRole("heading", { level: 1, name: "应用" })).toBeVisible();
      await spaceCard("个人").getByRole("button", { name: "购物清单的设置" }).click();
      dialog = page.getByRole("dialog", { name: "购物清单设置" });
      await dialog.getByRole("textbox", { name: "货架的新条目" }).fill("厨房");
      await dialog.getByRole("button", { name: "添加", exact: true }).click();
      await dialog.getByRole("switch", { name: "隐藏已勾选的物品" }).click();
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect(dialog).toBeHidden();
      expect(await settingsNow()).toEqual({ space: { aisles: ["Garden", "厨房"] }, user: { hideDone: false } });

      // The app's page, which reads its settings itself, offers the aisles the space now has.
      await page.goto(`/apps/${personalId}/${appId}`);
      const aisles = sandbox(page, appId).getByRole("group", { name: "货架" });
      await expect(aisles.getByRole("button")).toHaveText(["Garden", "厨房"]);

      // Switched off, it leaves this person's dashboard, and stays listed on the Apps page.
      await page.goto("/apps");
      await spaceCard("个人").getByRole("switch", { name: "显示购物清单" }).click();
      await expect(spaceCard("个人").getByRole("switch", { name: "显示购物清单" })).not.toBeChecked();
      expect((await sessionOf(request)).apps).toEqual([expect.objectContaining({ id: appId, enabled: false, pinned: true })]);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "还没有小组件" })).toBeVisible();
      expect(problems).toEqual([]);
    } finally {
      // Removing keeps settings, switches and pins, so put them back for whoever adds the app next.
      if (appId) {
        await request.patch(`/api/spaces/${personalId}/apps/${appId}/me`, { data: { enabled: true, pinned: false } });
        await request.patch(`/api/spaces/${personalId}/apps/${appId}/settings`, { data: { space: { aisles: [] }, user: { hideDone: false } } });
        await request.delete(`/api/spaces/${personalId}/apps/${appId}`);
      }
      await request.patch("/api/me", { data: { locale: "en" } });
    }
    expect((await sessionOf(request)).apps).toEqual([]);
  });

  test("two people share a family: the owner invites Lin, decides what she may do with each app, and lets her add one", async ({
    page,
    request,
    browser,
    playwright,
  }) => {
    // Two people, each in a browser of their own, and each page in its sandbox.
    test.setTimeout(60_000);
    // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
    const groupName = `Family ${Date.now().toString(36)}`;
    const item = `Buy bread ${Date.now()}`;
    const problems = watchForProblems(page);
    const card = (on: Page, name: string) => on.getByRole("main").getByRole("region", { name });
    const linContext = await browser.newContext({ baseURL: MEMBER_URL });
    const linPage = await linContext.newPage();
    const linProblems = watchForProblems(linPage);
    const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
    let groupId = "";
    let groceryId = "";
    let ideasId = "";

    try {
      // The server's owner creates the group in Settings.
      await page.goto("/settings");
      await card(page, "Groups").getByRole("button", { name: "Create a group" }).click();
      const create = page.getByRole("dialog", { name: "Create a group" });
      await create.getByLabel("Name").fill(groupName);
      await create.getByRole("button", { name: "Create" }).click();
      await expect(card(page, groupName).getByText("You are an owner")).toBeVisible();
      groupId = (await sessionOf(request)).spaces.find((space) => space.name === groupName)?.id ?? "";
      expect(groupId).not.toBe("");

      // The grocery list goes into the group for everyone to view, with an item on it.
      await page.goto("/apps");
      await card(page, groupName).getByRole("button", { name: "Add an app" }).click();
      const addApp = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
      await addApp.getByRole("radio", { name: /Grocery list/ }).check();
      await addApp.getByRole("radio", { name: "Everyone can view" }).check();
      await addApp.getByRole("button", { name: "Add", exact: true }).click();
      await expect(addApp).toBeHidden();
      groceryId = addedFrom(await sessionOf(request), groupId, "grocery");
      const grocery = `/api/spaces/${groupId}/apps/${groceryId}`;
      expect((await request.post(`${grocery}/rows/items`, { data: { data: { name: item, aisle: "", done: false } } })).status()).toBe(201);

      // Lin is not on the server yet: she is invited, and joins when she first opens Hearth.
      await page.goto("/settings");
      await card(page, groupName).getByRole("button", { name: "Add a person" }).click();
      const add = page.getByRole("dialog", { name: `Add a person to ${groupName}` });
      await add.getByLabel("Email address").fill(MEMBER_EMAIL);
      await add.getByRole("button", { name: "Add", exact: true }).click();
      // On a server an earlier run already introduced Lin to, she is added at once.
      await expect(card(page, groupName).getByText(new RegExp(`${MEMBER_EMAIL} (is invited|was added)`))).toBeVisible();

      // Lin arrives, and finds the group with what every member gets: the grocery list, to view.
      await linPage.goto("/");
      const linItem = sandbox(linPage, groceryId).getByRole("checkbox", { name: item });
      await expect(linItem).toBeDisabled();
      const linSession = await sessionOf(linApi);
      const linId = linSession.user.id;
      expect(linSession.spaces.find((space) => space.id === groupId)).toMatchObject({ name: groupName, role: "member" });
      expect(linSession.apps).toContainEqual(expect.objectContaining({ id: groceryId, spaceId: groupId, access: "view" }));
      // Nor does the server let her change it.
      const [row] = await rowsOf(linApi, groupId, groceryId, "items");
      expect((await linApi.patch(`${grocery}/rows/items/${String(row?.id)}`, { data: { data: { done: true } } })).status()).toBe(403);

      // The owner lets Lin edit the list; her card lets her tick it, and the owner sees it ticked.
      // The owner's controls show a change at once: Lin looks again once the server has it.
      const answered = (path: string, method: string) =>
        page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
      await page.reload();
      const table = card(page, groupName).getByRole("table", { name: "Who can use each app" });
      let access = answered(`${grocery}/access`, "PUT");
      await table.getByRole("combobox", { name: "lin's access to Grocery list" }).selectOption({ label: "Can edit" });
      expect((await access).status()).toBe(204);
      await expect(table.getByRole("combobox", { name: "lin's access to Grocery list" })).toHaveValue("edit");
      await linPage.reload();
      await linItem.click();
      // The card keeps only what is still to buy, at once; the server has the tick once it is saved.
      await expect(sandbox(linPage, groceryId).getByRole("heading", { name: "Nothing to buy." })).toBeVisible();
      await expect
        .poll(() => rowsOf(request, groupId, groceryId, "items"))
        .toEqual([expect.objectContaining({ name: item, done: true, updatedBy: linId })]);
      expect(linProblems).toEqual([]);

      // With no access, the app is gone for Lin: not in her session, and nothing of it answers her.
      access = answered(`${grocery}/access`, "PUT");
      await table.getByRole("combobox", { name: "lin's access to Grocery list" }).selectOption({ label: "No access" });
      expect((await access).status()).toBe(204);
      await expect(table.getByRole("combobox", { name: "lin's access to Grocery list" })).toHaveValue("none");
      await linPage.reload();
      await expect(linPage.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      await expect(linPage.locator(`iframe[data-made-app="${groceryId}"]`)).toHaveCount(0);
      expect((await sessionOf(linApi)).apps.filter((app) => app.spaceId === groupId)).toEqual([]);
      expect((await linApi.get(`${grocery}/rows/items`)).status()).toBe(404);
      expect((await linApi.get(`${grocery}/frame`)).status()).toBe(404);

      // Allowed to add apps, Lin adds Ideas to the group herself, and may change it.
      await card(page, groupName).getByRole("button", { name: "Manage lin" }).click();
      const manage = page.getByRole("dialog", { name: `lin in ${groupName}` });
      const allowed = answered(`/api/spaces/${groupId}/members/${linId}`, "PATCH");
      await manage.getByRole("switch", { name: "Can add apps" }).click();
      expect((await allowed).status()).toBe(204);
      await expect(manage.getByRole("switch", { name: "Can add apps" })).toHaveAttribute("aria-checked", "true");
      await manage.getByRole("button", { name: "Close" }).click();
      await linPage.goto("/apps");
      await card(linPage, groupName).getByRole("button", { name: "Add an app" }).click();
      const linAdd = linPage.getByRole("dialog", { name: `Add an app to ${groupName}` });
      await linAdd.getByRole("radio", { name: /Ideas/ }).check();
      await linAdd.getByRole("button", { name: "Add", exact: true }).click();
      await expect(card(linPage, groupName).getByRole("switch", { name: `Show Ideas in ${groupName}` })).toBeChecked();
      ideasId = addedFrom(await sessionOf(linApi), groupId, "ideas");
      expect((await sessionOf(linApi)).apps).toContainEqual(expect.objectContaining({ id: ideasId, spaceId: groupId, access: "edit" }));
      // Every other member gets what she chose, "only me for now": the owners' list says what was
      // stored, nothing for members and an exception for Lin, who added it. The owners can use it
      // whatever she chose.
      const stored = (await (await request.get(`/api/spaces/${groupId}/apps`)).json()) as {
        apps: { id: string; template?: string; memberAccess: string; members: Record<string, string> }[];
      };
      expect(stored.apps.find((app) => app.id === ideasId)).toEqual(
        expect.objectContaining({ template: "ideas", memberAccess: "none", members: { [linId]: "edit" } }),
      );
      expect((await sessionOf(request)).apps).toContainEqual(expect.objectContaining({ id: ideasId, spaceId: groupId, access: "edit" }));
      expect(problems).toEqual([]);
      expect(linProblems).toEqual([]);
    } finally {
      // The group stays (nothing deletes a space); its apps and its member go, so the owner's
      // dashboard is empty again for whatever runs next against the same server.
      if (groupId) {
        if (groceryId) await request.delete(`/api/spaces/${groupId}/apps/${groceryId}`);
        if (ideasId) await request.delete(`/api/spaces/${groupId}/apps/${ideasId}`);
        const lin = ((await (await linApi.get("/api/session")).json()) as { user?: { id: string } }).user;
        if (lin) await request.delete(`/api/spaces/${groupId}/members/${lin.id}`);
      }
      await linApi.dispose();
      await linContext.close();
    }
    expect((await sessionOf(request)).apps).toEqual([]);
  });

  test("GitHub Trending: the dialog names its host, its page fetches through the server, a failed refresh keeps the lists, and Lin may only read them", async ({
    page,
    request,
    browser,
    playwright,
  }) => {
    test.setTimeout(60_000);
    const SEARCH = "https://api.github.com/search/repositories";
    const created = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const repos = [
      { id: 9001, full_name: "sample-org/quill", description: "A sample editor", language: "TypeScript", stargazers_count: 4321, forks_count: 120, created_at: created },
      { id: 9002, full_name: "sample-org/lantern", description: "A sample lamp", language: "Rust", stargazers_count: 1234, forks_count: 56, created_at: created },
    ];
    // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
    const groupName = `Newsroom ${Date.now().toString(36)}`;
    /** A moment as the page writes it, on the browser's clock, which is UTC here: "14:05". */
    const timeOf = (at: unknown) => new Date(String(at)).toISOString().slice(11, 16);
    const problems = watchForProblems(page);
    const linContext = await browser.newContext({ ...PHONE, baseURL: MEMBER_URL, locale: "zh-CN", timezoneId: "UTC", colorScheme: "light" });
    const linPage = await linContext.newPage();
    const linProblems = watchForProblems(linPage);
    const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
    let groupId = "";
    let appId = "";

    try {
      // GitHub's search answers with two new repositories, from the file of stand-ins both copies of the server read.
      writeStandIns([{ url: SEARCH, body: { total_count: repos.length, incomplete_results: false, items: repos } }]);

      // A group of the owner and Lin, who arrives and reads Chinese.
      const group = await request.post("/api/spaces", { data: { name: groupName } });
      expect(group.status()).toBe(201);
      groupId = ((await group.json()) as { id: string }).id;
      expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
      expect((await sessionOf(linApi)).spaces).toContainEqual(expect.objectContaining({ id: groupId, role: "member" }));
      expect((await linApi.patch("/api/me", { data: { locale: "zh" } })).status()).toBe(200);

      // The owner adds GitHub Trending to the group for everyone to view. The dialog names the host it fetches from.
      await page.goto("/apps");
      await page.getByRole("main").getByRole("region", { name: groupName }).getByRole("button", { name: "Add an app" }).click();
      const add = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
      await add.getByRole("radio", { name: /GitHub Trending/ }).check();
      const choice = add.locator("label", { has: page.getByRole("radio", { name: /GitHub Trending/ }) });
      await expect(choice.getByText("Fetches data from api.github.com on its own.")).toBeVisible();
      await add.getByRole("radio", { name: "Everyone can view" }).check();
      await add.getByRole("button", { name: "Add", exact: true }).click();
      await expect(add).toBeHidden();
      appId = addedFrom(await sessionOf(request), groupId, "trending");
      const refreshesNow = () => rowsOf(request, groupId, appId, "refreshes");
      // Nothing has fetched anything yet: the page does, when someone who may edit opens it.
      expect(await refreshesNow()).toEqual([]);

      // The owner opens its page, which refreshes the lists by itself, through the server.
      await page.goto(`/apps/${groupId}/${appId}`);
      const ownerPage = sandbox(page, appId);
      await expect(ownerPage.getByRole("link", { name: "sample-org/quill" })).toBeVisible({ timeout: 15_000 });
      await expect(ownerPage.getByRole("link", { name: "sample-org/lantern" })).toBeVisible();
      // What it says on the page, besides what it tells a screen reader.
      const shown = (text: string) => ownerPage.getByRole("paragraph").filter({ hasText: text });
      await expect(shown("Updated just now")).toBeVisible();
      expect(await refreshesNow()).toEqual([expect.objectContaining({ ok: true, error: "" })]);

      // GitHub cannot be reached now. "Refresh now" fails, and the lists of the last good refresh stay.
      writeStandIns([{ url: SEARCH, error: "network" }]);
      await ownerPage.getByRole("button", { name: "Refresh now" }).click();
      await expect.poll(async () => (await refreshesNow()).filter((row) => row.ok === false && row.error !== "running").length, { timeout: 15_000 }).toBe(1);
      const rows = await refreshesNow();
      const good = rows.find((row) => row.ok === true);
      const failed = rows.find((row) => row.ok === false);
      const failure = `Couldn't reach GitHub at ${timeOf(failed?.updatedAt)}. Showing results from ${timeOf(good?.updatedAt)}.`;
      await expect(shown(failure)).toBeVisible({ timeout: 10_000 });
      await expect(ownerPage.getByRole("link", { name: "sample-org/quill" })).toBeVisible();
      await expect(ownerPage.getByRole("button", { name: "Try again" })).toBeVisible();

      // Lin, who may only view, on her phone and in Chinese: the same lists and the same failure in her card ...
      await linPage.goto("/");
      const linCard = sandbox(linPage, appId);
      await expect(linCard.getByRole("link", { name: "sample-org/quill" })).toBeVisible();
      await expect(
        linCard.getByRole("paragraph").filter({ hasText: `${timeOf(failed?.updatedAt)} 时无法连接 GitHub。现在显示的是 ${timeOf(good?.updatedAt)} 的结果。` }),
      ).toBeVisible();
      await expectNothingPastTheEdge(linPage);
      // ... and on the app's page, with nothing to refresh or hide.
      await linPage.goto(`/apps/${groupId}/${appId}`);
      const linView = sandbox(linPage, appId);
      await expect(linView.getByRole("link", { name: "sample-org/lantern" })).toBeVisible();
      await expect(linView.getByRole("button", { name: /^(立即刷新|重试|隐藏)$/ })).toHaveCount(0);
      // Nor does the server let her write the lists.
      const write = await linApi.post(`/api/spaces/${groupId}/apps/${appId}/rows/refreshes`, {
        data: { data: { at: new Date().toISOString(), ok: false, error: "running" } },
      });
      expect(write.status()).toBe(403);
      // The one search GitHub could not answer: the server said so with a 502, which the browser logs as it logs any failed request.
      expect(problems).toEqual(["console: Failed to load resource: the server responded with a status of 502 (Bad Gateway)"]);
      expect(linProblems).toEqual([]);
    } finally {
      // The group stays (nothing deletes a space); the app and Lin leave it, and the owner's
      // dashboard is empty again for whatever runs next against the same server.
      if (groupId) {
        if (appId) await request.delete(`/api/spaces/${groupId}/apps/${appId}`);
        const lin = ((await (await linApi.get("/api/session")).json()) as { user?: { id: string } }).user;
        if (lin) await request.delete(`/api/spaces/${groupId}/members/${lin.id}`);
      }
      await linApi.dispose();
      await linContext.close();
    }
    expect((await sessionOf(request)).apps).toEqual([]);
  });
});

test.describe("a built-in app", () => {
  // Playwright blocks service workers with a script it runs in every frame, which reads
  // navigator.serviceWorker; a sandboxed frame refuses that, and the page would report an error
  // that is the test's own. With service workers allowed nothing is injected, so every error is real.
  test.use({ serviceWorkers: "allow" });

  test("is a page in the sandbox: the owner adds the family's grocery list from the Add dialog, and Lin ticks what they buy", async ({
    page,
    request,
    browser,
    playwright,
  }) => {
    // Two people, each in a browser of their own, and each page in its sandbox.
    test.setTimeout(60_000);
    type Session = { user: { id: string }; apps: { id: string; spaceId: string; template?: string }[] };
    const groupName = `Shop ${Date.now().toString(36)}`;
    const milk = `Milk ${Date.now().toString(36)}`;
    const problems = watchForProblems(page);
    const linContext = await browser.newContext({ baseURL: MEMBER_URL });
    const linPage = await linContext.newPage();
    const linProblems = watchForProblems(linPage);
    const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
    let groupId = "";
    let appId = "";

    try {
      groupId = ((await (await request.post("/api/spaces", { data: { name: groupName } })).json()) as { id: string }).id;
      expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
      // Lin arrives, so that she is in the group.
      expect((await linApi.get("/api/session")).status()).toBe(200);

      // The owner adds the built-in grocery list to the group from the Add dialog, for everyone to edit.
      await page.goto("/apps");
      await page.getByRole("main").getByRole("region", { name: groupName }).getByRole("button", { name: "Add an app" }).click();
      const add = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
      await add.getByRole("radio", { name: /Grocery list/ }).check();
      await add.getByRole("radio", { name: "Everyone can edit" }).check();
      await add.getByRole("button", { name: "Add", exact: true }).click();
      await expect(add).toBeHidden();
      const session = (await (await request.get("/api/session")).json()) as Session;
      appId = session.apps.find((app) => app.spaceId === groupId && app.template === "grocery")?.id ?? "";
      expect(appId).toMatch(/^m-[a-z0-9]{10}$/);

      // On the app's own page, in the sandbox, the owner puts milk on the list.
      await page.goto(`/apps/${groupId}/${appId}`);
      await sandbox(page, appId).getByLabel("Add an item").fill(milk);
      await sandbox(page, appId).getByRole("button", { name: "Add", exact: true }).click();
      await expect(sandbox(page, appId).getByRole("checkbox", { name: milk })).not.toBeChecked();

      // Lin, in her own browser on her copy of the server, finds it in the card on her dashboard and ticks
      // it; the card keeps only what is still to buy.
      await linPage.goto("/");
      const linMilk = sandbox(linPage, appId).getByRole("checkbox", { name: milk });
      await expect(linMilk).not.toBeChecked();
      await linMilk.click();
      await expect(linMilk).toHaveCount(0);

      // The server keeps one row, ticked by Lin, and the owner's page shows it so once read again. The card
      // let the item go before its tick was saved (nothing was left to buy), so the save may still be on
      // its way.
      const linId = ((await (await linApi.get("/api/session")).json()) as Session).user.id;
      await expect
        .poll(() => rowsOf(request, groupId, appId, "items"))
        .toEqual([expect.objectContaining({ name: milk, done: true, updatedBy: linId })]);
      await page.reload();
      await expect(sandbox(page, appId).getByRole("checkbox", { name: milk })).toBeChecked();
      expect(problems).toEqual([]);
      expect(linProblems).toEqual([]);
    } finally {
      // The group stays (nothing deletes a space); its app and its member go.
      if (groupId) {
        if (appId) await request.delete(`/api/spaces/${groupId}/apps/${appId}`);
        const lin = ((await (await linApi.get("/api/session")).json()) as { user?: { id: string } }).user;
        if (lin) await request.delete(`/api/spaces/${groupId}/members/${lin.id}`);
      }
      await linApi.dispose();
      await linContext.close();
    }
  });
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

    const session = page.waitForResponse((response) => response.url().endsWith("/api/session"));
    await page.reload();
    expect((await session).fromServiceWorker()).toBe(false);
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    expect(problems).toEqual([]);
  });
});
