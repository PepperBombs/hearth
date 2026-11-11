/**
 * The grocery list of hearth-stones, built into Hearth by
 * playwright.mini-apps.config.ts, used by two people of one family on one
 * server: the owner at a desk, in English, and Lin on her phone, in
 * Chinese, each in a browser of their own. They share one list, see each
 * other's changes without reloading, share the aisles their space has set,
 * and each keeps their own "Hide ticked items".
 *
 * The app lives in the other repository (`hearth-stones/grocery`); when
 * its texts or layout change there, this file changes with them.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PHONE, expectNothingPastTheEdge } from "../fixtures.ts";
import { MEMBER_EMAIL, MINI_APPS_MEMBER_URL } from "../servers.ts";

type Item = { name: string; aisle: string; done: boolean; createdBy: string };
type Session = { user: { id: string }; spaces: { id: string; role: string }[] };

/** Collects script errors and anything the browser refused because of the Content-Security-Policy. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

/** One aisle of the list's page: a region named after it. */
const aisle = (page: Page, name: string): Locator => page.getByRole("main").getByRole("region", { name });

test("two people of a family share one grocery list, each on their own screen and in their own language", async ({
  page,
  request,
  browser,
  playwright,
}) => {
  // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
  const groupName = `Family ${Date.now().toString(36)}`;
  const ownerName = `Grocery list in ${groupName}`;
  const linName = `${groupName}的购物清单`;
  const problems = watchForProblems(page);
  // The owner's page keeps its own time, so that waiting for the list to be read again takes no real time.
  await page.clock.install();
  const linContext = await browser.newContext({
    ...PHONE,
    baseURL: MINI_APPS_MEMBER_URL,
    locale: "zh-CN",
    timezoneId: "UTC",
    colorScheme: "light",
    serviceWorkers: "block",
  });
  const linPage = await linContext.newPage();
  const linProblems = watchForProblems(linPage);
  const linApi = await playwright.request.newContext({ baseURL: MINI_APPS_MEMBER_URL });

  try {
    // The owner makes a group for the family and invites Lin. She arrives, and reads Chinese.
    const created = await request.post("/api/spaces", { data: { name: groupName } });
    expect(created.status()).toBe(201);
    const groupId = ((await created.json()) as { id: string }).id;
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
    const linSession = (await (await linApi.get("/api/session")).json()) as Session;
    expect(linSession.spaces).toContainEqual(expect.objectContaining({ id: groupId, role: "member" }));
    expect((await linApi.patch("/api/me", { data: { locale: "zh" } })).status()).toBe(200);
    const grocery = `/api/spaces/${groupId}/apps/grocery`;
    const listNow = async () => ((await (await request.post(`${grocery}/q/list`, { data: {} })).json()) as { output: Item[] }).output;

    // The build holds the grocery list: on the Apps page the owner adds it to the group, for everyone to edit.
    await page.goto("/apps");
    await page.getByRole("main").getByRole("region", { name: groupName }).getByRole("button", { name: "Add an app" }).click();
    const addApp = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
    await addApp.getByRole("radio", { name: /Grocery list/ }).check();
    await addApp.getByRole("radio", { name: "Everyone can edit" }).check();
    await addApp.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addApp).toBeHidden();

    // Its card is on the dashboard, empty, and leads to its page.
    await page.goto("/");
    const ownerCard = page.getByRole("region", { name: ownerName });
    await expect(ownerCard.getByText("Nothing to buy.")).toBeVisible();
    await ownerCard.getByRole("link", { name: `Open ${ownerName}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Grocery list" })).toBeVisible();

    // The owner gives the family's list two aisles, a setting of the space.
    await page.getByRole("button", { name: `Settings of ${ownerName}` }).click();
    const settings = page.getByRole("dialog", { name: "Grocery list settings" });
    for (const name of ["Dairy", "Bakery"]) {
      await settings.getByRole("textbox", { name: "New entry in Aisles" }).fill(name);
      await settings.getByRole("button", { name: "Add", exact: true }).click();
    }
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toBeHidden();

    // And puts milk and bread on it, each under its aisle.
    const ownerMain = page.getByRole("main");
    for (const [name, where] of [
      ["Milk", "Dairy"],
      ["Bread", "Bakery"],
    ] as const) {
      await ownerMain.getByRole("textbox", { name: "Add an item" }).fill(name);
      await ownerMain.getByRole("group", { name: "Aisle" }).getByRole("button", { name: where }).click();
      await ownerMain.getByRole("button", { name: "Add", exact: true }).click();
      await expect(aisle(page, where).getByRole("checkbox", { name })).not.toBeChecked();
    }

    // Lin, on her phone, finds both on her dashboard, in Chinese: the app's own strings and the shell's.
    await linPage.goto("/");
    const linCard = linPage.getByRole("region", { name: linName });
    await expect(linCard.getByRole("checkbox", { name: "Milk" })).not.toBeChecked();
    await expect(linCard.getByRole("checkbox", { name: "Bread" })).not.toBeChecked();
    await expect(linCard.getByText("还剩 2 项")).toBeVisible();

    // On the list's page she sees the aisles the owner set. She adds eggs, and milk, which is there already.
    await linCard.getByRole("link", { name: `打开 ${linName}` }).click();
    await expect(linPage.getByRole("heading", { level: 1, name: "购物清单" })).toBeVisible();
    await expect(aisle(linPage, "Bakery").getByRole("checkbox", { name: "Bread" })).toBeVisible();
    const linMain = linPage.getByRole("main");
    const linBox = linMain.getByRole("textbox", { name: "添加物品" });
    await linBox.fill("eggs");
    await linMain.getByRole("group", { name: "货架" }).getByRole("button", { name: "Dairy" }).click();
    await linMain.getByRole("button", { name: "添加", exact: true }).click();
    await expect(aisle(linPage, "Dairy").getByRole("checkbox", { name: "eggs" })).toBeVisible();
    await linBox.fill("milk");
    await linMain.getByRole("button", { name: "添加", exact: true }).click();
    await expect(linBox).toHaveValue("");
    await expect(aisle(linPage, "Dairy").getByRole("checkbox")).toHaveCount(2);
    expect((await listNow()).map((item) => item.name)).toEqual(["Milk", "Bread", "eggs"]);
    await expectNothingPastTheEdge(linPage);

    // The owner's page, left as it was, shows her eggs once the list is read again, which happens every 15 seconds.
    const ownerDairy = aisle(page, "Dairy");
    await page.clock.runFor(16_000);
    await expect(ownerDairy.getByRole("checkbox", { name: "eggs" })).toBeVisible();

    // In the shop, Lin ticks the milk off. The owner sees it ticked.
    await aisle(linPage, "Dairy").getByRole("checkbox", { name: "Milk" }).click();
    await expect(aisle(linPage, "Dairy").getByRole("checkbox", { name: "Milk" })).toBeChecked();
    await page.clock.runFor(16_000);
    await expect(ownerDairy.getByRole("checkbox", { name: "Milk" })).toBeChecked();

    // Lin hides ticked items, for herself alone: the milk leaves her page and stays on the owner's.
    await linPage.getByRole("button", { name: `${linName}的设置` }).click();
    const linSettings = linPage.getByRole("dialog", { name: "购物清单设置" });
    await linSettings.getByRole("switch", { name: "隐藏已勾选的物品" }).click();
    await linSettings.getByRole("button", { name: "保存" }).click();
    await expect(linSettings).toBeHidden();
    await expect(aisle(linPage, "Dairy").getByRole("checkbox", { name: "Milk" })).toHaveCount(0);
    await expect(aisle(linPage, "Dairy").getByRole("checkbox", { name: "eggs" })).toBeVisible();
    expect(await (await linApi.get(`${grocery}/settings`)).json()).toEqual({
      space: { aisles: ["Dairy", "Bakery"] },
      user: { hideDone: true },
    });
    expect(await (await request.get(`${grocery}/settings`)).json()).toEqual({
      space: { aisles: ["Dairy", "Bakery"] },
      user: { hideDone: false },
    });
    await page.clock.runFor(16_000);
    await expect(ownerDairy.getByRole("checkbox", { name: "Milk" })).toBeChecked();

    // Home again, the owner clears what was bought. Lin's dashboard has what is still to buy.
    await ownerMain.getByRole("button", { name: "Clear ticked" }).click();
    await expect(ownerDairy.getByRole("checkbox", { name: "Milk" })).toHaveCount(0);
    await linPage.goto("/");
    await expect(linCard.getByRole("checkbox", { name: "Bread" })).not.toBeChecked();
    await expect(linCard.getByRole("checkbox", { name: "eggs" })).not.toBeChecked();
    await expect(linCard.getByRole("checkbox", { name: "Milk" })).toHaveCount(0);
    await expect(linCard.getByText("还剩 2 项")).toBeVisible();
    await expectNothingPastTheEdge(linPage);

    // One list for the space, and every row says who wrote it.
    const ownerId = ((await (await request.get("/api/session")).json()) as Session).user.id;
    expect(await listNow()).toEqual([
      expect.objectContaining({ name: "Bread", aisle: "Bakery", done: false, createdBy: ownerId }),
      expect.objectContaining({ name: "eggs", aisle: "Dairy", done: false, createdBy: linSession.user.id }),
    ]);
    expect(problems).toEqual([]);
    expect(linProblems).toEqual([]);
  } finally {
    await linApi.dispose();
    await linContext.close();
  }
});

test("the page lists each item once, under each aisle once, whatever the space's list of aisles holds", async ({ page, request }) => {
  const created = await request.post("/api/spaces", { data: { name: `Aisles ${Date.now().toString(36)}` } });
  expect(created.status()).toBe(201);
  const groupId = ((await created.json()) as { id: string }).id;
  const grocery = `/api/spaces/${groupId}/apps/grocery`;
  expect((await request.put(grocery, { data: {} })).status()).toBe(204);
  // The settings form lets the same aisle be added twice, and an entry be emptied.
  const aisles = ["Dairy", "", "Dairy", "Bakery"];
  expect((await request.patch(`${grocery}/settings`, { data: { space: { aisles } } })).status()).toBe(200);
  // An item may also have an aisle the space no longer has.
  for (const input of [{ name: "Milk", aisle: "Dairy" }, { name: "Bread", aisle: "Bakery" }, { name: "Salt" }, { name: "Peas", aisle: "Frozen" }]) {
    expect((await request.post(`${grocery}/m/add`, { data: { input } })).status()).toBe(200);
  }

  await page.goto(`/apps/${groupId}/grocery`);
  const main = page.getByRole("main");
  await expect(aisle(page, "Dairy").getByRole("checkbox", { name: "Milk" })).toBeVisible();
  await expect(aisle(page, "Bakery").getByRole("checkbox", { name: "Bread" })).toBeVisible();
  await expect(aisle(page, "Other").getByRole("checkbox")).toHaveCount(2);
  await expect(aisle(page, "Other").getByRole("checkbox", { name: "Salt" })).toBeVisible();
  await expect(aisle(page, "Other").getByRole("checkbox", { name: "Peas" })).toBeVisible();
  await expect(main.getByRole("region")).toHaveCount(3);
  await expect(main.getByRole("checkbox")).toHaveCount(4);
  await expect(main.getByRole("group", { name: "Aisle" }).getByRole("button")).toHaveText(["Dairy", "Bakery"]);
});
