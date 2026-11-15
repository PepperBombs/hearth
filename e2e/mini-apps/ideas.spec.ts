/**
 * Ideas of hearth-stones, built into Hearth by
 * playwright.mini-apps.config.ts: a timeline of short notes, written down
 * the moment they come. First the owner alone, at a desk and in English:
 * an idea written on the dashboard card, then on the app's page ideas with
 * #tags in two scripts, found by tag and by search, pinned, edited,
 * archived, brought back and deleted. Then two people of one family on one
 * server: Lin on her phone, in Chinese, who may only read at first and may
 * write once the owner lets her, each in a browser of their own.
 *
 * The app lives in the other repository (`hearth-stones/ideas`); when its
 * texts or layout change there, this file changes with them.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PHONE, expectNothingPastTheEdge } from "../fixtures.ts";
import { MEMBER_EMAIL, MINI_APPS_MEMBER_URL } from "../servers.ts";

type Idea = { id: string; text: string; tags: string[]; pinned: boolean; archived: boolean; createdBy: string };
type Session = { user: { id: string }; spaces: { id: string; role: string }[] };

// Made-up ideas, as someone might jot them down.
const TENT = "Lend the tent to the neighbours";
const HERBS = "Plant a herb box on the balcony #Garden";
const TOFU = "周末试试自己做豆腐 #厨房";
/** Two lines, and the tag of the herbs in another case. */
const CORNER = "A reading corner by the window:\na lamp and two cushions #garden #home";
const HERBS_EDITED = "Plant a herb box on the kitchen windowsill #厨房";
/** A word and a web address with nowhere to break, longer than a phone is wide. The "#" in the address starts no tag. */
const LONG =
  "Supercalifragilisticexpialidociousandthensomemorelettersthatneverend " +
  "https://example.com/a/very/long/path/that/goes/on/and/on/and/on/without/a/single/break#section-seven";

/** Collects script errors and anything the browser refused because of the Content-Security-Policy. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

/** The ideas of a timeline as a person reads them, top to bottom: each one's text, line breaks included. */
const texts = (timeline: Locator): Promise<string[]> =>
  timeline.getByRole("listitem").evaluateAll((items) => items.map((item) => item.querySelector("p")?.textContent ?? ""));

/** One idea of a timeline, found by its text. */
const idea = (timeline: Locator, text: string): Locator => timeline.getByRole("listitem").filter({ hasText: text });

test("the owner writes ideas down at once, then tags, finds, pins, edits, archives and deletes them", async ({ page, request }) => {
  // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
  const groupName = `Notebook ${Date.now().toString(36)}`;
  const cardName = `Ideas in ${groupName}`;
  const problems = watchForProblems(page);
  const created = await request.post("/api/spaces", { data: { name: groupName } });
  expect(created.status()).toBe(201);
  const groupId = ((await created.json()) as { id: string }).id;
  const ideas = `/api/spaces/${groupId}/apps/ideas`;
  expect((await request.put(ideas, { data: {} })).status()).toBe(204);
  const kept = async (view: "active" | "archived") =>
    ((await (await request.post(`${ideas}/q/list`, { data: { input: { view } } })).json()) as { output: { ideas: Idea[] } }).output.ideas;

  // The card on the dashboard is empty and has a box: an idea typed there and Enter, and it is written down.
  await page.goto("/");
  const card = page.getByRole("region", { name: cardName });
  await expect(card.getByText("No ideas yet.")).toBeVisible();
  const quick = card.getByRole("textbox", { name: "Write an idea" });
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await quick.fill(TENT);
  await quick.press("Enter");
  await expect(quick).toHaveValue("");
  await expect(card.getByRole("listitem")).toHaveText([`${TENT}just now`]);

  // It is on the app's page too, the only one of the timeline.
  await card.getByRole("link", { name: `Open ${cardName}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ideas" })).toBeVisible();
  const main = page.getByRole("main");
  const active = main.getByRole("list", { name: /^Active/ });
  await expect.poll(() => texts(active)).toEqual([TENT]);

  // Three more, written in the page's box: with "Save", and with Ctrl+Enter, since Enter there starts a new line.
  const box = main.getByRole("textbox", { name: "Write an idea" });
  const save = main.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await box.fill(HERBS);
  await save.click();
  await expect(box).toHaveValue("");
  for (const text of [TOFU, CORNER]) {
    await box.fill(text);
    await box.press("Control+Enter");
    await expect(box).toHaveValue("");
  }
  // The newest first, each as it was typed: the two lines are two lines.
  await expect.poll(() => texts(active)).toEqual([CORNER, TOFU, HERBS, TENT]);
  expect(await idea(active, "A reading corner").locator("p").first().evaluate((text) => getComputedStyle(text).whiteSpace)).toBe("pre-wrap");
  const views = main.getByRole("group", { name: "Ideas shown" });
  await expect(views.getByRole("button")).toHaveText(["Active (4)", "Archived (0)"]);

  // Their #tags are chips, the most used first: "#Garden" and "#garden" are one tag, and a Chinese tag is a tag.
  const tags = main.getByRole("group", { name: "Tags" });
  await expect(tags.getByRole("button")).toHaveText(["#garden 2", "#home 1", "#厨房 1"]);

  // A chip shows the ideas with its tag, and all of them again when pressed again.
  const kitchen = tags.getByRole("button", { name: "#厨房 1" });
  await kitchen.click();
  await expect(kitchen).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => texts(active)).toEqual([TOFU]);
  await kitchen.click();
  await expect(kitchen).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => texts(active)).toEqual([CORNER, TOFU, HERBS, TENT]);
  // A tag in an idea's text does what its chip does.
  await idea(active, HERBS).getByRole("button", { name: "#Garden" }).click();
  await expect(tags.getByRole("button", { name: "#garden 2" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => texts(active)).toEqual([CORNER, HERBS]);
  await tags.getByRole("button", { name: "#garden 2" }).click();
  await expect.poll(() => texts(active)).toEqual([CORNER, TOFU, HERBS, TENT]);

  // A search finds the ideas that hold every word typed, in any case. While its answer is on its way the
  // timeline shown stays, dimmed and busy, and the skeleton never takes the page's place.
  const search = main.getByRole("searchbox", { name: "Search ideas" });
  let letThrough = () => {};
  const heldBack = new Promise<void>((resolve) => (letThrough = resolve));
  const listRoute = `**/api/spaces/${groupId}/apps/ideas/q/list`;
  await page.route(listRoute, async (route) => {
    await heldBack;
    await route.continue();
  });
  await search.fill("BALCONY herb");
  await expect(active).toHaveAttribute("aria-busy", "true");
  await expect(active).toHaveClass(/opacity-60/);
  expect(await texts(active)).toEqual([CORNER, TOFU, HERBS, TENT]);
  // Long enough for the search to have been sent.
  await page.waitForTimeout(500);
  await expect(page.getByTestId("app-skeleton")).toHaveCount(0);
  letThrough();
  await expect.poll(() => texts(active)).toEqual([HERBS]);
  await expect(active).not.toHaveAttribute("aria-busy");
  await page.unroute(listRoute);
  await search.fill("豆腐");
  await expect.poll(() => texts(active)).toEqual([TOFU]);
  // Nothing holds these words: the page says so, and "Clear filters" shows everything again.
  await search.fill("a word nobody wrote");
  await expect(main.getByRole("heading", { name: "Nothing found." })).toBeVisible();
  await main.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect.poll(() => texts(active)).toEqual([CORNER, TOFU, HERBS, TENT]);

  // The oldest is pinned: it moves to the top with its mark, and the focus goes with it.
  const pin = idea(active, TENT).getByRole("button", { name: "Pin", exact: true });
  await expect(pin).toHaveAccessibleDescription(TENT);
  await pin.click();
  await expect.poll(() => texts(active)).toEqual([TENT, CORNER, TOFU, HERBS]);
  await expect(idea(active, TENT).getByText("Pinned")).toBeVisible();
  await expect(idea(active, TENT).getByRole("button", { name: "Unpin" })).toBeFocused();

  // An idea is edited in its place. Escape leaves it as it was; "Save" keeps the new text, and its tags follow.
  await idea(active, HERBS).getByRole("button", { name: "Edit" }).click();
  const editBox = active.getByRole("textbox", { name: "Edit this idea" });
  await expect(editBox).toBeFocused();
  await expect(editBox).toHaveValue(HERBS);
  await editBox.fill("Never mind");
  await editBox.press("Escape");
  await expect(editBox).toHaveCount(0);
  await expect.poll(() => texts(active)).toEqual([TENT, CORNER, TOFU, HERBS]);
  await idea(active, HERBS).getByRole("button", { name: "Edit" }).click();
  await editBox.fill(HERBS_EDITED);
  await active.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => texts(active)).toEqual([TENT, CORNER, TOFU, HERBS_EDITED]);
  await expect(idea(active, HERBS_EDITED).getByRole("button", { name: "Edit" })).toBeFocused();
  await expect(tags.getByRole("button")).toHaveText(["#厨房 2", "#garden 1", "#home 1"]);

  // Archived, the pinned idea leaves the timeline and is kept, unpinned, among the archived ones.
  await idea(active, TENT).getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(() => texts(active)).toEqual([CORNER, TOFU, HERBS_EDITED]);
  await expect(views.getByRole("button")).toHaveText(["Active (3)", "Archived (1)"]);
  await views.getByRole("button", { name: "Archived (1)" }).click();
  const archived = main.getByRole("list", { name: /^Archived/ });
  await expect.poll(() => texts(archived)).toEqual([TENT]);
  await expect(archived.getByText("Pinned")).toHaveCount(0);
  await expect(archived.getByRole("button")).toHaveText(["Edit", "Bring back", "Delete"]);
  // Brought back, it is in the timeline again, where its day puts it.
  await archived.getByRole("button", { name: "Bring back" }).click();
  await expect(main.getByRole("heading", { name: "Nothing archived." })).toBeVisible();
  await views.getByRole("button", { name: "Active (4)" }).click();
  await expect.poll(() => texts(active)).toEqual([CORNER, TOFU, HERBS_EDITED, TENT]);

  // "Delete" asks first. "Cancel" keeps the idea; "Delete" in the dialog takes it away for good.
  const dialog = page.getByRole("dialog", { name: "Delete this idea?" });
  await idea(active, TOFU).getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByText(TOFU)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await texts(active)).toEqual([CORNER, TOFU, HERBS_EDITED, TENT]);
  await idea(active, TOFU).getByRole("button", { name: "Delete" }).click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => texts(active)).toEqual([CORNER, HERBS_EDITED, TENT]);
  await expect(active).toBeFocused();
  await expect(tags.getByRole("button")).toHaveText(["#garden 1", "#home 1", "#厨房 1"]);

  // What the server keeps: the three, each with the tags of its text, folded, and none archived.
  expect(await kept("active")).toEqual([
    expect.objectContaining({ text: CORNER, tags: ["garden", "home"], pinned: false, archived: false }),
    expect.objectContaining({ text: HERBS_EDITED, tags: ["厨房"], pinned: false, archived: false }),
    expect.objectContaining({ text: TENT, tags: [], pinned: false, archived: false }),
  ]);
  expect(await kept("archived")).toEqual([]);

  // The card has the three written last.
  await page.goto("/");
  await expect(card.getByRole("listitem")).toHaveCount(3);
  await expect(card.getByRole("listitem").first()).toContainText("A reading corner by the window:");
  expect(problems).toEqual([]);
});

test("a family shares one timeline: Lin reads it on her phone, in Chinese, and writes once she may edit", async ({
  page,
  request,
  browser,
  playwright,
}) => {
  const groupName = `Family ${Date.now().toString(36)}`;
  const linName = `${groupName}的想法`;
  const problems = watchForProblems(page);
  // The owner's page keeps its own time, so that waiting for the timeline to be read again takes no real time.
  await page.clock.install();
  const linContext = await browser.newContext({
    ...PHONE,
    baseURL: MINI_APPS_MEMBER_URL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
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
    const ideas = `/api/spaces/${groupId}/apps/ideas`;

    // On the Apps page the owner adds Ideas to the group, for everyone to view.
    await page.goto("/apps");
    await page.getByRole("main").getByRole("region", { name: groupName }).getByRole("button", { name: "Add an app" }).click();
    const addApp = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
    await addApp.getByRole("radio", { name: /Ideas/ }).check();
    await addApp.getByRole("radio", { name: "Everyone can view" }).check();
    await addApp.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addApp).toBeHidden();

    // And writes three ideas on its page, the first of them pinned; one has nowhere to break.
    await page.goto(`/apps/${groupId}/ideas`);
    const main = page.getByRole("main");
    const active = main.getByRole("list", { name: /^Active/ });
    const box = main.getByRole("textbox", { name: "Write an idea" });
    for (const text of [TOFU, HERBS, LONG]) {
      await box.fill(text);
      await box.press("Control+Enter");
      await expect(box).toHaveValue("");
    }
    await idea(active, TOFU).getByRole("button", { name: "Pin", exact: true }).click();
    await expect.poll(() => texts(active)).toEqual([TOFU, LONG, HERBS]);
    // In a group, each idea names who wrote it.
    await expect(idea(active, TOFU).getByText("owner", { exact: true })).toBeVisible();

    // Lin, on her phone, finds them on her dashboard, in Chinese: the newest first, and no box to write in.
    await linPage.goto("/");
    const linCard = linPage.getByRole("region", { name: linName });
    await expect(linCard.getByRole("listitem")).toHaveCount(3);
    await expect(linCard.getByRole("listitem").nth(1)).toContainText(HERBS);
    await expect(linCard.getByText("刚刚").first()).toBeVisible();
    await expect(linCard.getByRole("textbox")).toHaveCount(0);
    await expect(linCard.getByRole("button", { name: "保存" })).toHaveCount(0);
    await expectNothingPastTheEdge(linPage);

    // On the app's page she reads the whole timeline, the pinned idea first, and can search and filter it,
    // but there is nothing to write in and nothing to change an idea with.
    await linCard.getByRole("link", { name: `打开 ${linName}` }).click();
    await expect(linPage.getByRole("heading", { level: 1, name: "想法" })).toBeVisible();
    const linMain = linPage.getByRole("main");
    const linActive = linMain.getByRole("list", { name: /^当前/ });
    await expect.poll(() => texts(linActive)).toEqual([TOFU, LONG, HERBS]);
    await expect(idea(linActive, TOFU).getByText("已置顶")).toBeVisible();
    await expect(linMain.getByRole("group", { name: "显示范围" }).getByRole("button")).toHaveText(["当前（3）", "已归档（0）"]);
    await expect(linMain.getByRole("textbox", { name: "写下一个想法" })).toHaveCount(0);
    for (const name of ["保存", "置顶", "取消置顶", "编辑", "归档", "删除"]) {
      await expect(linMain.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    const linTags = linMain.getByRole("group", { name: "标签" });
    await expect(linTags.getByRole("button")).toHaveText(["#garden 1", "#厨房 1"]);
    await linTags.getByRole("button", { name: "#厨房 1" }).click();
    await expect.poll(() => texts(linActive)).toEqual([TOFU]);
    await linMain.getByRole("searchbox", { name: "搜索想法" }).fill("阳台");
    await expect(linMain.getByRole("heading", { name: "没有找到。" })).toBeVisible();
    await linMain.getByRole("button", { name: "清除筛选" }).click();
    await expect.poll(() => texts(linActive)).toEqual([TOFU, LONG, HERBS]);
    // The long word and the long address wrap inside their card: nothing reaches past the phone's edge.
    await expectNothingPastTheEdge(linPage);
    // The server refuses her what the page does not offer.
    expect((await linApi.post(`${ideas}/m/add`, { data: { input: { text: "Not allowed" } } })).status()).toBe(403);

    // The owner lets every member edit. Lin's page has the box and the actions now, each large enough for a thumb.
    expect((await request.put(`${ideas}/access`, { data: { memberAccess: "edit" } })).status()).toBe(204);
    await linPage.reload();
    const linBox = linMain.getByRole("textbox", { name: "写下一个想法" });
    const linHerbs = idea(linActive, HERBS);
    const targets = [
      linBox,
      linMain.getByRole("button", { name: "保存" }),
      linMain.getByRole("searchbox", { name: "搜索想法" }),
      linMain.getByRole("button", { name: "当前（3）" }),
      linMain.getByRole("button", { name: "已归档（0）" }),
      ...["置顶", "编辑", "归档", "删除"].map((name) => linHerbs.getByRole("button", { name, exact: true })),
    ];
    for (const target of targets) {
      await expect(target).toBeVisible();
      expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(40);
    }
    await expect(linHerbs.getByRole("button")).toHaveText(["#Garden", "置顶", "编辑", "归档", "删除"]);
    await expectNothingPastTheEdge(linPage);

    // She writes an idea of her own, and puts the herbs away: asked first when deleting, in Chinese.
    await linBox.fill("给阳台的花换个大一点的盆 #garden");
    await linMain.getByRole("button", { name: "保存" }).click();
    await expect(linBox).toHaveValue("");
    await expect.poll(() => texts(linActive)).toEqual([TOFU, "给阳台的花换个大一点的盆 #garden", LONG, HERBS]);
    await linHerbs.getByRole("button", { name: "归档", exact: true }).click();
    await expect(linMain.getByRole("group", { name: "显示范围" }).getByRole("button")).toHaveText(["当前（3）", "已归档（1）"]);
    await idea(linActive, LONG).getByRole("button", { name: "删除" }).click();
    const linDialog = linPage.getByRole("dialog", { name: "删除这个想法？" });
    await expect(linDialog).toBeVisible();
    await expectNothingPastTheEdge(linPage);
    await linDialog.getByRole("button", { name: "删除" }).click();
    await expect(linDialog).toBeHidden();
    await expect.poll(() => texts(linActive)).toEqual([TOFU, "给阳台的花换个大一点的盆 #garden"]);
    await expectNothingPastTheEdge(linPage);

    // The owner's page, left as it was, shows all of it once the timeline is read again, which happens every 15 seconds.
    await page.clock.runFor(16_000);
    await expect.poll(() => texts(active)).toEqual([TOFU, "给阳台的花换个大一点的盆 #garden"]);
    await expect(idea(active, "给阳台的花").getByText("lin", { exact: true })).toBeVisible();
    await expect(main.getByRole("group", { name: "Ideas shown" }).getByRole("button")).toHaveText(["Active (2)", "Archived (1)"]);
    await expect(main.getByRole("group", { name: "Tags" }).getByRole("button")).toHaveText(["#garden 1", "#厨房 1"]);

    // One timeline for the space, and every idea says who wrote it.
    const ownerId = ((await (await request.get("/api/session")).json()) as Session).user.id;
    const all = async (view: string) =>
      ((await (await request.post(`${ideas}/q/list`, { data: { input: { view } } })).json()) as { output: { ideas: Idea[] } }).output.ideas;
    expect(await all("active")).toEqual([
      expect.objectContaining({ text: TOFU, pinned: true, createdBy: ownerId }),
      expect.objectContaining({ text: "给阳台的花换个大一点的盆 #garden", tags: ["garden"], createdBy: linSession.user.id }),
    ]);
    expect(await all("archived")).toEqual([expect.objectContaining({ text: HERBS, archived: true, createdBy: ownerId })]);
    expect(problems).toEqual([]);
    expect(linProblems).toEqual([]);
  } finally {
    await linApi.dispose();
    await linContext.close();
  }
});
