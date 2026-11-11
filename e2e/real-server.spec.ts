/**
 * The web app against the real server (see playwright.config.ts for how it is started).
 * Everything else in this folder answers /api itself; these few tests check that
 * the two halves really fit: the session, saving preferences, the security
 * headers the server sends, the routes for apps as the built server answers
 * them, the sample apps the build was given (packages/fixture-apps), the
 * screen for someone who was not invited, and a family of two people: the
 * owner and Lin, each with a copy of the server of their own over one
 * database, who share a group and an app the owner then moves out of it and
 * back.
 */
import { expect, test, type Page } from "@playwright/test";
import { GUEST_URL, MEMBER_EMAIL, MEMBER_URL, OWNER_EMAIL, SERVER_VERSION } from "./servers.ts";

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

test("on the Apps page an app is added without a rebuild, pinned, given settings in both languages and switched off", async ({
  page,
  request,
}) => {
  type Listed = { id: string; spaceId: string; enabled: boolean; pinned: boolean };
  const sessionNow = async () =>
    (await (await request.get("/api/session")).json()) as { spaces: { id: string; kind: string }[]; apps: Listed[] };
  const personal = (await sessionNow()).spaces.find((space) => space.kind === "personal");
  expect(personal).toBeDefined();
  const checklist = `/api/spaces/${personal?.id}/apps/checklist`;
  const settingsNow = async () => (await (await request.get(`${checklist}/settings`)).json()) as unknown;
  const problems = watchForProblems(page);
  const spaceCard = (name: string) => page.getByRole("main").getByRole("region", { name });

  try {
    await page.goto("/apps");
    // Nothing is in the personal space yet, and the build holds two apps to choose from.
    const mine = spaceCard("Personal");
    await mine.getByRole("button", { name: "Add an app" }).click();
    const add = page.getByRole("dialog", { name: "Add an app to your personal space" });
    await add.getByRole("radio", { name: /Checklist/ }).check();
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add).toBeHidden();
    await expect(mine.getByRole("switch", { name: "Show Checklist" })).toBeChecked();
    expect((await sessionNow()).apps).toEqual([expect.objectContaining({ id: "checklist", enabled: true })]);

    // Pinned: kept by the server, so a reload still shows it.
    await mine.getByRole("button", { name: "Pin Checklist" }).click();
    await expect(page.getByRole("region", { name: "Pinned" }).getByRole("link", { name: "Checklist" })).toBeVisible();
    await page.reload();
    await expect(mine.getByRole("button", { name: "Pin Checklist" })).toHaveAttribute("aria-pressed", "true");
    expect((await sessionNow()).apps).toEqual([expect.objectContaining({ id: "checklist", pinned: true })]);

    // A setting of the space and one of this person's own, in English.
    await mine.getByRole("button", { name: "Settings of Checklist" }).click();
    let dialog = page.getByRole("dialog", { name: "Checklist settings" });
    await dialog.getByRole("textbox", { name: "New entry in Sections" }).fill("Garden");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("switch", { name: "Hide ticked items" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    expect(await settingsNow()).toEqual({ space: { sections: ["Garden"] }, user: { hideDone: true } });

    // And in Chinese.
    await savePreferences(page, () => page.getByRole("button", { name: /Switch language/ }).click());
    await expect(page.getByRole("heading", { level: 1, name: "应用" })).toBeVisible();
    await spaceCard("个人").getByRole("button", { name: "清单的设置" }).click();
    dialog = page.getByRole("dialog", { name: "清单设置" });
    await dialog.getByRole("textbox", { name: "分组的新条目" }).fill("厨房");
    await dialog.getByRole("button", { name: "添加", exact: true }).click();
    await dialog.getByRole("switch", { name: "隐藏已勾选的事项" }).click();
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    expect(await settingsNow()).toEqual({ space: { sections: ["Garden", "厨房"] }, user: { hideDone: false } });

    // The page draws the sections the space now has.
    await page.goto(`/apps/${personal?.id}/checklist`);
    await expect(page.getByRole("main").getByRole("button", { name: "厨房" })).toBeVisible();

    // Switched off, it leaves this person's dashboard, and stays listed on the Apps page.
    await page.goto("/apps");
    await spaceCard("个人").getByRole("switch", { name: "显示清单" }).click();
    await expect(spaceCard("个人").getByRole("switch", { name: "显示清单" })).not.toBeChecked();
    expect((await sessionNow()).apps).toEqual([expect.objectContaining({ id: "checklist", enabled: false, pinned: true })]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "还没有小组件" })).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    // Removing keeps settings, switches and pins, so put them back for whoever adds the app next.
    await request.patch(`${checklist}/me`, { data: { enabled: true, pinned: false } });
    await request.patch(`${checklist}/settings`, { data: { space: { sections: [] }, user: { hideDone: false } } });
    await request.delete(checklist);
    await request.patch("/api/me", { data: { locale: "en" } });
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

test("two people share a family: the owner invites Lin, decides what she may do with each app, and lets her add one", async ({
  page,
  request,
  browser,
  playwright,
}) => {
  type Listed = { id: string; spaceId: string; access: string };
  type Session = { spaces: { id: string; kind: string; name: string; role: string }[]; apps: Listed[] };
  const ownerSession = async () => (await (await request.get("/api/session")).json()) as Session;
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

  try {
    // The server's owner creates the group in Settings.
    await page.goto("/settings");
    await card(page, "Groups").getByRole("button", { name: "Create a group" }).click();
    const create = page.getByRole("dialog", { name: "Create a group" });
    await create.getByLabel("Name").fill(groupName);
    await create.getByRole("button", { name: "Create" }).click();
    await expect(card(page, groupName).getByText("You are an owner")).toBeVisible();
    groupId = (await ownerSession()).spaces.find((space) => space.name === groupName)?.id ?? "";
    expect(groupId).not.toBe("");

    // The checklist goes into the group for everyone to view, with an item in it.
    await page.goto("/apps");
    await card(page, groupName).getByRole("button", { name: "Add an app" }).click();
    const addApp = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
    await addApp.getByRole("radio", { name: /Checklist/ }).check();
    await addApp.getByRole("radio", { name: "Everyone can view" }).check();
    await addApp.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addApp).toBeHidden();
    const checklist = `/api/spaces/${groupId}/apps/checklist`;
    expect((await request.post(`${checklist}/m/add`, { data: { input: { name: item } } })).status()).toBe(200);

    // Lin is not on the server yet: she is invited, and joins when she first opens Hearth.
    await page.goto("/settings");
    await card(page, groupName).getByRole("button", { name: "Add a person" }).click();
    const add = page.getByRole("dialog", { name: `Add a person to ${groupName}` });
    await add.getByLabel("Email address").fill(MEMBER_EMAIL);
    await add.getByRole("button", { name: "Add", exact: true }).click();
    // On a server an earlier run already introduced Lin to, she is added at once.
    await expect(card(page, groupName).getByText(new RegExp(`${MEMBER_EMAIL} (is invited|was added)`))).toBeVisible();

    // Lin arrives, and finds the group with what every member gets: the checklist, to view.
    await linPage.goto("/");
    const linCard = linPage.getByTestId("widget-grid").locator("section", { has: linPage.getByRole("heading", { level: 2, name: "Checklist" }) });
    await expect(linCard.getByRole("checkbox", { name: item })).toBeDisabled();
    const linSession = (await (await linApi.get("/api/session")).json()) as Session;
    expect(linSession.spaces.find((space) => space.id === groupId)).toMatchObject({ name: groupName, role: "member" });
    expect(linSession.apps).toContainEqual(expect.objectContaining({ id: "checklist", spaceId: groupId, access: "view" }));
    const items = (await (await linApi.post(`${checklist}/q/list`, { data: {} })).json()) as { output: { id: string }[] };
    const tick = await linApi.post(`${checklist}/m/tick`, { data: { input: { id: items.output[0]?.id, done: true } } });
    expect(tick.status()).toBe(403);

    // The owner lets Lin edit the checklist; her widget lets her tick it, and the owner sees it ticked.
    await page.reload();
    const table = card(page, groupName).getByRole("table", { name: "Who can use each app" });
    await table.getByRole("combobox", { name: "lin's access to Checklist" }).selectOption({ label: "Can edit" });
    await expect(table.getByRole("combobox", { name: "lin's access to Checklist" })).toHaveValue("edit");
    await linPage.reload();
    await linCard.getByRole("checkbox", { name: item }).click();
    await expect(linCard.getByText("Nothing to do.")).toBeVisible();
    const seenByOwner = (await (await request.post(`${checklist}/q/list`, { data: {} })).json()) as { output: { name: string; done: boolean }[] };
    expect(seenByOwner.output).toEqual([expect.objectContaining({ name: item, done: true })]);
    expect(linProblems).toEqual([]);

    // With no access, the app is gone for Lin: not in her session, and nothing of it answers her.
    await table.getByRole("combobox", { name: "lin's access to Checklist" }).selectOption({ label: "No access" });
    await expect(table.getByRole("combobox", { name: "lin's access to Checklist" })).toHaveValue("none");
    await linPage.reload();
    await expect(linPage.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(linCard).toHaveCount(0);
    expect(((await (await linApi.get("/api/session")).json()) as Session).apps.filter((app) => app.spaceId === groupId)).toEqual([]);
    expect((await linApi.post(`${checklist}/q/list`, { data: {} })).status()).toBe(404);

    // Allowed to add apps, Lin adds the feed to the group herself, and may change it.
    await card(page, groupName).getByRole("button", { name: "Manage lin" }).click();
    const manage = page.getByRole("dialog", { name: `lin in ${groupName}` });
    await manage.getByRole("switch", { name: "Can add apps" }).click();
    await expect(manage.getByRole("switch", { name: "Can add apps" })).toHaveAttribute("aria-checked", "true");
    await manage.getByRole("button", { name: "Close" }).click();
    await linPage.goto("/apps");
    await card(linPage, groupName).getByRole("button", { name: "Add an app" }).click();
    const linAdd = linPage.getByRole("dialog", { name: `Add an app to ${groupName}` });
    await linAdd.getByRole("radio", { name: /Feed/ }).check();
    await linAdd.getByRole("button", { name: "Add", exact: true }).click();
    await expect(card(linPage, groupName).getByRole("switch", { name: `Show Feed in ${groupName}` })).toBeChecked();
    expect(((await (await linApi.get("/api/session")).json()) as Session).apps).toContainEqual(
      expect.objectContaining({ id: "feed", spaceId: groupId, access: "edit" }),
    );
    // Everyone else gets what the member who added it chose: "only me for now".
    expect((await ownerSession()).apps).toContainEqual(expect.objectContaining({ id: "feed", spaceId: groupId, access: "edit" }));
    expect(problems).toEqual([]);
  } finally {
    // The group stays (nothing deletes a space); its apps and its member go, so the owner's
    // dashboard is empty again for whatever runs next against the same server.
    if (groupId) {
      await request.delete(`/api/spaces/${groupId}/apps/checklist`);
      await request.delete(`/api/spaces/${groupId}/apps/feed`);
      const lin = ((await (await linApi.get("/api/session")).json()) as { user?: { id: string } }).user;
      if (lin) await request.delete(`/api/spaces/${groupId}/members/${lin.id}`);
    }
    await linApi.dispose();
    await linContext.close();
  }
  expect((await ownerSession()).apps).toEqual([]);
});

test("the owner moves a group's checklist into their own space and back: its data goes along, access starts afresh", async ({
  page,
  request,
  playwright,
}) => {
  type Listed = { id: string; spaceId: string; access: string; pinned: boolean };
  type Session = { user: { id: string }; spaces: { id: string; kind: string; name: string }[]; apps: Listed[] };
  type Item = { name: string; createdBy: string };
  const ownerSession = async () => (await (await request.get("/api/session")).json()) as Session;
  const owner = await ownerSession();
  const personalId = owner.spaces.find((space) => space.kind === "personal")?.id ?? "";
  const inPersonal = `/api/spaces/${personalId}/apps/checklist`;
  // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
  const groupName = `Movers ${Date.now().toString(36)}`;
  const ownItem = `Sample from the owner ${Date.now()}`;
  const linItem = `Sample from Lin ${Date.now()}`;
  const problems = watchForProblems(page);
  const card = (name: string) => page.getByRole("main").getByRole("region", { name });
  const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
  const linSession = async () => (await (await linApi.get("/api/session")).json()) as Session;
  const itemsAt = async (api: typeof request, address: string) =>
    ((await (await api.post(`${address}/q/list`, { data: {} })).json()) as { output: Item[] }).output.map((item) => [item.name, item.createdBy]);
  let groupId = "";

  try {
    // A group of the owner and Lin, with the checklist for both to change, an item from each,
    // the sections everyone shares, and each one's own setting and pin.
    const created = await request.post("/api/spaces", { data: { name: groupName } });
    expect(created.status()).toBe(201);
    groupId = ((await created.json()) as { id: string }).id;
    const inGroup = `/api/spaces/${groupId}/apps/checklist`;
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
    // Her first request makes an invited Lin arrive; on a server she already uses, she was added at once.
    const lin = (await linSession()).user;
    expect((await request.put(inGroup, { data: { memberAccess: "edit" } })).status()).toBe(204);
    expect((await request.post(`${inGroup}/m/add`, { data: { input: { name: ownItem } } })).status()).toBe(200);
    expect((await linApi.post(`${inGroup}/m/add`, { data: { input: { name: linItem } } })).status()).toBe(200);
    expect((await request.patch(`${inGroup}/settings`, { data: { space: { sections: ["Garden"] }, user: { hideDone: true } } })).status()).toBe(200);
    expect((await linApi.patch(`${inGroup}/settings`, { data: { user: { hideDone: true } } })).status()).toBe(200);
    expect((await request.patch(`${inGroup}/me`, { data: { pinned: true } })).status()).toBe(204);
    expect((await linApi.patch(`${inGroup}/me`, { data: { pinned: true } })).status()).toBe(204);

    // Apps are not merged: a space that has the checklist, or had it and kept its data, cannot take this one.
    expect((await request.put(inPersonal, { data: {} })).status()).toBe(204);
    expect((await request.post(`${inGroup}/move`, { data: { toSpaceId: personalId } })).status()).toBe(409);
    expect((await request.delete(inPersonal)).status()).toBe(204);
    expect((await request.post(`${inGroup}/move`, { data: { toSpaceId: personalId } })).status()).toBe(409);
    // Earlier tests also leave it removed there with data. Deleting that data makes room.
    expect((await request.delete(`${inPersonal}/data`, { data: { confirm: "checklist" } })).status()).toBe(204);

    // The owner moves it on the Apps page into their own space.
    await page.goto("/apps");
    await card(groupName).getByRole("button", { name: `Move Checklist in ${groupName}`, exact: true }).click();
    let dialog = page.getByRole("dialog", { name: `Move Checklist in ${groupName} to another space` });
    await dialog.getByRole("radio", { name: /Personal/ }).check();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(card("Personal").getByText("Checklist was moved here.")).toBeFocused();

    // Both items arrived, each still by whoever wrote it, with the sections and the owner's own pin and setting.
    expect(await itemsAt(request, inPersonal)).toEqual([
      [ownItem, owner.user.id],
      [linItem, lin.id],
    ]);
    expect(await (await request.get(`${inPersonal}/settings`)).json()).toEqual({ space: { sections: ["Garden"] }, user: { hideDone: true } });
    expect((await ownerSession()).apps).toEqual([expect.objectContaining({ id: "checklist", spaceId: personalId, access: "edit", pinned: true })]);
    // Lin is not in the owner's own space: the app is gone for her, at the old address and the new one.
    expect((await linSession()).apps.filter((app) => app.id === "checklist")).toEqual([]);
    expect((await linApi.post(`${inGroup}/q/list`, { data: {} })).status()).toBe(404);
    expect((await linApi.post(`${inPersonal}/q/list`, { data: {} })).status()).toBe(404);

    // Back into the group, for everyone to view.
    await card("Personal").getByRole("button", { name: "Move Checklist", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Move Checklist to another space" });
    await dialog.getByRole("radio", { name: new RegExp(groupName) }).check();
    await dialog.getByRole("radio", { name: "Everyone can view" }).check();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(card(groupName).getByText("Checklist was moved here.")).toBeFocused();

    // Lin has it again, as everyone gets it now, and the data is all there; her own pin and setting
    // did not survive the time in a space she is not in, and her old edit access did not come back.
    expect((await linSession()).apps.filter((app) => app.id === "checklist")).toEqual([
      expect.objectContaining({ spaceId: groupId, access: "view", pinned: false }),
    ]);
    expect(await (await linApi.get(`${inGroup}/settings`)).json()).toEqual({ space: { sections: ["Garden"] }, user: { hideDone: false } });
    expect(await itemsAt(linApi, inGroup)).toEqual([
      [ownItem, owner.user.id],
      [linItem, lin.id],
    ]);
    expect((await linApi.post(`${inGroup}/m/add`, { data: { input: { name: "Sample not allowed" } } })).status()).toBe(403);
    // The owner's own pin and setting made both trips.
    expect((await ownerSession()).apps).toEqual([expect.objectContaining({ id: "checklist", spaceId: groupId, pinned: true })]);
    expect(await (await request.get(`${inGroup}/settings`)).json()).toEqual({ space: { sections: ["Garden"] }, user: { hideDone: true } });
    expect(problems).toEqual([]);
  } finally {
    // The group stays (nothing deletes a space); the app and Lin leave it, and the owner's
    // dashboard is empty again for whatever runs next against the same server.
    if (groupId) {
      await request.delete(`/api/spaces/${groupId}/apps/checklist`);
      await request.delete(inPersonal);
      const lin = ((await (await linApi.get("/api/session")).json()) as { user?: { id: string } }).user;
      if (lin) await request.delete(`/api/spaces/${groupId}/members/${lin.id}`);
    }
    await linApi.dispose();
  }
  expect((await ownerSession()).apps).toEqual([]);
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
