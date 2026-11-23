/**
 * How the chat page is laid out, in a real browser, where jsdom cannot
 * measure: the list's rows, the notice above the box when it is off, the
 * fade where the conversation meets the box, reaching the conversation from
 * the keyboard and the box fitting its text at any width. The server is the
 * stand-in of e2e/fixtures.ts, whose made-up model answers "Noted: " and
 * the message; nothing reaches a real model.
 */
import type { Page } from "@playwright/test";
import type { Session } from "../packages/shared/src/index.ts";
import { PERSONAL_SPACE, PHONE, expect, expectNothingPastTheEdge, sessionWithApps, test, type FakeApi } from "./fixtures.ts";

/** A session whose spaces all let the person's model work, or none of them. */
function sessionWith(assistant: "none" | "edit", locale: "en" | "zh" = "en"): Session {
  const session = sessionWithApps({ locale });
  return { ...session, spaces: session.spaces.map((space) => ({ ...space, assistant })) };
}

/** A reply long enough to fill a screen, in Markdown: paragraphs, a list, a table and code. */
function longReply(n: number): string {
  return [
    `## Step ${n}`,
    "Here is how I would **set it up**, so that each day's spending is kept in one place:",
    "1. One collection, `expenses`, with an `item` and an `amount`.\n2. A card on the dashboard with **today's total**.\n3. A list you can edit.",
    "| Field | Type | Required |\n| --- | --- | --- |\n| item | text | yes |\n| amount | number | yes |\n| when | date | no |",
    "```\nexpenses: item, amount, when\n```",
    "Tell me what to add, and I will keep it.",
  ].join("\n\n");
}

/** Two conversations in the person's space: a long one and a short one. */
function twoConversations(api: FakeApi): { long: string; short: string } {
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const long = "Make me a ledger for my daily spending";
  const short = "Groceries";
  const entries = Array.from({ length: 5 }, (_, index) => [
    { kind: "user" as const, text: index === 0 ? long : `And step ${index + 1}?` },
    { kind: "model" as const, text: longReply(index + 1) },
  ]).flat();
  api.chats = {
    [PERSONAL_SPACE]: [
      { chat: { id: "chat-long", title: long, createdAt: at(1), updatedAt: at(1) }, entries: [...entries, { kind: "user", text: "The last thing said" }] },
      { chat: { id: "chat-short", title: short, createdAt: at(30), updatedAt: at(30) }, entries: [{ kind: "user", text: short }] },
    ],
  };
  return { long, short };
}

const MODEL = { protocol: "openai" as const, baseUrl: "https://api.example.com/v1", model: "sample-model", hasKey: true };

/** The conversation, which scrolls by itself above the box. */
const messages = (page: Page) => page.getByRole("region", { name: "Messages" });
const listOn = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

test.describe("the chat on a desktop", () => {
  test("a row of the list gives its title the whole row, and its delete button takes the time's place where the pointer is", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    const { long, short } = twoConversations(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-short`);
    await expect(listOn(page).getByRole("link")).toHaveCount(2);
    for (const title of [long, short]) {
      // With a mouse the delete button keeps no room on a row it is not shown on: the time ends where the row does.
      const row = listOn(page).getByRole("listitem").filter({ hasText: title });
      const rowBox = await row.boundingBox();
      const timeBox = await row.locator("time").boundingBox();
      expect(rowBox && timeBox && rowBox.x + rowBox.width - (timeBox.x + timeBox.width)).toBeLessThanOrEqual(10);
    }
    // On hover the button takes the time's place, and leaves the title where it was.
    const row = listOn(page).getByRole("listitem").filter({ hasText: long });
    const titleBefore = await row.locator(".clip").boundingBox();
    await row.hover();
    const del = row.getByRole("button", { name: `Delete conversation ${long}` });
    await expect(del).toHaveCSS("opacity", "1");
    await expect(row.locator("time")).toHaveCSS("visibility", "hidden");
    const delBox = await del.boundingBox();
    const timeBox = await row.locator("time").boundingBox();
    expect(delBox && timeBox && delBox.x >= timeBox.x - 1 && delBox.x + delBox.width <= timeBox.x + timeBox.width + 8).toBe(true);
    expect(await row.locator(".clip").boundingBox()).toEqual(titleBefore);
    await page.mouse.move(0, 0);
    await expect(row.locator("time")).toHaveCSS("visibility", "visible");
    // The keyboard shows it too, and it still opens the dialog.
    await del.focus();
    await expect(del).toHaveCSS("opacity", "1");
    await expect(row.locator("time")).toHaveCSS("visibility", "hidden");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Delete this conversation?" })).toBeVisible();
  });

  test("the conversation fades into the box where they meet, and its last line is never under the fade", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    twoConversations(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-long`);
    const region = messages(page);
    const last = page.getByText("The last thing said");
    await expect(last).toBeVisible();
    const fade = page.locator("[data-composer-fade]");
    await expect(fade).toHaveCSS("pointer-events", "none");
    expect(await fade.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("gradient");
    // Opened, it is at its end: the last line sits above the fade.
    const form = page.locator("form").filter({ has: page.getByRole("textbox", { name: "Message your model" }) });
    await expect.poll(async () => {
      const lastBox = await last.boundingBox();
      const fadeBox = await fade.boundingBox();
      return lastBox && fadeBox ? fadeBox.y - (lastBox.y + lastBox.height) : -1;
    }).toBeGreaterThanOrEqual(0);
    // Scrolled back, what is cut by the end of the conversation is under the fade, not right on the box.
    await region.evaluate((element) => (element.scrollTop = 0));
    const regionBox = (await region.boundingBox())!;
    const fadeBox = (await fade.boundingBox())!;
    const formBox = (await form.boundingBox())!;
    expect(fadeBox.y).toBeLessThan(regionBox.y + regionBox.height - 8);
    expect(fadeBox.y + fadeBox.height).toBeGreaterThanOrEqual(regionBox.y + regionBox.height);
    expect(fadeBox.y + fadeBox.height).toBeLessThanOrEqual(formBox.y + 1);
    expect(formBox.y - (regionBox.y + regionBox.height)).toBeGreaterThanOrEqual(8);
  });

  test("the keyboard reaches the conversation after the skip link, and scrolls it", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    twoConversations(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-long`);
    await expect(page.getByText("The last thing said")).toBeVisible();
    const region = messages(page);
    // Opened at its end.
    await expect.poll(() => region.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    await page.locator('a[href="#content"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#content")).toBeFocused();
    for (let step = 0; step < 20 && !(await region.evaluate((element) => element === document.activeElement)); step += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(region).toBeFocused();
    const before = await region.evaluate((element) => element.scrollTop);
    await page.keyboard.press("PageUp");
    await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeLessThan(before);
  });

  test("in an open conversation where the assistant is off, the notice above the box is one line, as wide as the box", async ({ page, api }) => {
    api.setSession(sessionWith("none"));
    api.model = MODEL;
    twoConversations(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-long`);
    await expect(page.getByText("The last thing said")).toBeVisible();
    const allow = page.getByRole("button", { name: "Allow it here" });
    await expect(allow).toBeVisible();
    const notice = page.locator("div", { has: allow }).last();
    const box = (await notice.boundingBox())!;
    const form = (await page.locator("form").filter({ has: page.getByRole("textbox", { name: "Message your model" }) }).boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(64);
    expect(box.width).toBeLessThanOrEqual(form.width + 1);
    // So is the one that asks for a model.
    api.model = null;
    await page.reload();
    await expect(page.getByText("The last thing said")).toBeVisible();
    const choose = page.getByRole("link", { name: "Choose your model" });
    await expect(choose).toBeVisible();
    expect((await page.locator("div", { has: choose }).last().boundingBox())!.height).toBeLessThanOrEqual(64);
  });

  test("the box to write in fits its text again when its width changes", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat");
    const box = page.getByRole("textbox", { name: "Message your model" });
    await expect(box).toBeEnabled();
    await box.fill("A ledger for my daily spending, with the date, what it was and how much, and a total for each week. ".repeat(2));
    const fits = () =>
      box.evaluate((element: HTMLTextAreaElement) => {
        const kept = element.style.height;
        element.style.height = "auto";
        const needs = Math.min(element.scrollHeight, parseFloat(getComputedStyle(element).maxHeight));
        element.style.height = kept;
        return Math.abs(element.getBoundingClientRect().height - needs) <= 1;
      });
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 }); // turned: fewer lines, no blank ones left
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 320, height: 844 }); // narrower: more lines, not scrolled under the cap
    await expect.poll(fits).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 }); // the list beside it
    await expect.poll(fits).toBe(true);
  });
});

test.describe("the chat on a phone", () => {
  test.use(PHONE);

  test("in an open conversation where the assistant is off, the notice above the box stays small, in both languages", async ({ page, api }) => {
    for (const locale of ["en", "zh"] as const) {
      api.setSession(sessionWith("none", locale));
      api.model = MODEL;
      twoConversations(api);
      await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-long`);
      await expect(page.getByText("The last thing said")).toBeVisible();
      const allow = page.getByRole("button", { name: locale === "zh" ? "在这里允许" : "Allow it here" });
      await expect(allow).toBeVisible();
      const notice = (await page.locator("div", { has: allow }).last().boundingBox())!;
      const form = (await page.locator("form").boundingBox())!;
      expect(notice.height).toBeLessThanOrEqual(100);
      expect(notice.width).toBeLessThanOrEqual(form.width + 1);
      await expectNothingPastTheEdge(page);
    }
  });

  test("a row's delete button shows on a touch screen, where there is no hover", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    const { short } = twoConversations(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-long`);
    await page.getByRole("button", { name: "Conversations" }).click();
    const list = page.getByRole("dialog", { name: "Conversations" });
    const del = list.getByRole("button", { name: `Delete conversation ${short}` });
    await expect(del).toHaveCSS("opacity", "1");
    await expect(list.getByRole("listitem").filter({ hasText: short }).locator("time")).toBeVisible();
    await expectNothingPastTheEdge(page);
  });
});
