/**
 * How the chat page is laid out, in a real browser, where jsdom cannot
 * measure: the list's rows, the notice above the box when it is off, the
 * fade where the conversation meets the box, reaching the conversation from
 * the keyboard and the box fitting its text at any width. And the card of a
 * request of the model's to delete rows: answered with Delete or Cancel,
 * what it says after, a refusal, and that it fits a phone. The server is
 * the stand-in of e2e/fixtures.ts, whose made-up model answers "Noted: "
 * and the message; nothing reaches a real model.
 */
import type { Page } from "@playwright/test";
import type { ChatEntry, Session } from "../packages/shared/src/index.ts";
import { PERSONAL_SPACE, PHONE, expect, expectNothingPastTheEdge, sandbox, sessionWithApps, test, type FakeApi } from "./fixtures.ts";

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

/**
 * A conversation in the person's space in which their model made the Notes
 * app (its card drawn in the conversation) and then asked twice to delete
 * rows of it: seven entries, of which five are shown, then one. Both wait
 * for an answer unless `status` says otherwise.
 */
function deleteRequests(api: FakeApi, options: { status?: "pending" | "expired"; preview?: string[]; appName?: string } = {}): void {
  const at = new Date(Date.now() - 60_000).toISOString();
  const appName = options.appName ?? "Notes";
  const asked = (confirmationId: string, count: number, preview: string[]): ChatEntry => ({
    kind: "action",
    action: "delete_requested",
    appId: "notes",
    appName,
    confirmationId,
    collection: "notes",
    count,
    preview,
    status: options.status ?? "pending",
    deleted: 0,
  });
  api.chats = {
    [PERSONAL_SPACE]: [
      {
        chat: { id: "chat-tidy", title: "Tidy up my notes", createdAt: at, updatedAt: at },
        entries: [
          { kind: "user", text: "Make me somewhere to keep notes" },
          { kind: "action", action: "app_created", appId: "notes", appName },
          { kind: "user", text: "Tidy up my notes: delete last week's" },
          asked("confirm-week", 7, options.preview ?? ["Call the plumber", "Buy stamps", "Water the ferns", "Book the dentist", "Return the library books"]),
          { kind: "model", text: "I asked you before deleting them." },
          { kind: "user", text: "And the one about lunch" },
          asked("confirm-lunch", 1, ["Lunch with Kim · 12.50"]),
        ],
      },
    ],
  };
}

const DECIDE = `/api/spaces/${PERSONAL_SPACE}/chats/chat-tidy/confirmations`;

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

test.describe("a request of the model's to delete", () => {
  test("is a card: what would go, Delete and Cancel; the answer stays after a reload, and the app's page reads its rows again", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    deleteRequests(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-tidy`);
    const week = page.getByRole("group", { name: "Delete 7 entries from “Notes”?" });
    const lunch = page.getByRole("group", { name: "Delete 1 entry from “Notes”?" });
    await expect(week.getByRole("listitem")).toHaveText(["Call the plumber", "Buy stamps", "Water the ferns", "Book the dentist", "Return the library books"]);
    await expect(week.getByText("and 2 more")).toBeVisible();
    await expect(lunch.getByRole("listitem")).toHaveText(["Lunch with Kim · 12.50"]);
    // The app the model made is drawn in the conversation; it has heard of no change yet.
    const notes = sandbox(page, "notes").locator("body");
    await expect(notes).toHaveAttribute("data-changes", "0");

    // Delete: the rows go, the card says so in place of its buttons, and the app's page reads its rows again.
    await week.getByRole("button", { name: "Delete" }).click();
    await expect(week.getByRole("status")).toHaveText("Deleted 7 entries.");
    await expect(week.getByRole("button")).toHaveCount(0);
    await expect(notes).toHaveAttribute("data-changes", "1");

    // Cancel: nothing goes, and nothing needs reading again.
    await lunch.getByRole("button", { name: "Cancel" }).click();
    await expect(lunch.getByRole("status")).toHaveText("Kept: nothing was deleted.");
    await expect(lunch.getByRole("button")).toHaveCount(0);
    expect(api.confirmationRequests).toEqual([`${DECIDE}/confirm-week {"decision":"confirm"}`, `${DECIDE}/confirm-lunch {"decision":"decline"}`]);
    await expect(notes).toHaveAttribute("data-changes", "1");

    // Read back from the server, both cards say what became of them, here or on any other device.
    await page.reload();
    await expect(week.getByRole("status")).toHaveText("Deleted 7 entries.");
    await expect(lunch.getByRole("status")).toHaveText("Kept: nothing was deleted.");
    await expect(page.getByRole("main").getByRole("button", { name: /^(Delete|Cancel)$/ })).toHaveCount(0);
  });

  test("a refusal says why and leaves the request waiting; one answered elsewhere shows that answer", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    deleteRequests(api);
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-tidy`);
    const week = page.getByRole("group", { name: "Delete 7 entries from “Notes”?" });

    // The space's owners switched the assistant to reading only since: nothing goes, and the buttons stay.
    api.confirmationFailure = { status: 403, code: "forbidden", message: "Sample failure" };
    await week.getByRole("button", { name: "Delete" }).click();
    await expect(week.getByRole("alert")).toHaveText("Nothing was deleted: you, or your model, may no longer change this app here.");
    await expect(week.getByRole("button", { name: "Delete" })).toBeEnabled();
    await expect(week.getByRole("button", { name: "Cancel" })).toBeEnabled();

    // Meanwhile the person cancelled it on their phone: the server says it was answered, and the card shows how.
    api.confirmationFailure = null;
    const entry = api.chats[PERSONAL_SPACE]![0]!.entries.find((candidate) => candidate.kind === "action" && candidate.confirmationId === "confirm-week");
    Object.assign(entry!, { status: "declined", deleted: 0 });
    await week.getByRole("button", { name: "Delete" }).click();
    await expect(week.getByRole("status")).toHaveText("Kept: nothing was deleted.");
    await expect(week.getByRole("button")).toHaveCount(0);
    await expect(week.getByRole("alert")).toHaveCount(0);
  });

  test("an expired request says so, with nothing to answer", async ({ page, api }) => {
    api.setSession(sessionWith("edit"));
    api.model = MODEL;
    deleteRequests(api, { status: "expired" });
    await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-tidy`);
    for (const name of ["Delete 7 entries from “Notes”?", "Delete 1 entry from “Notes”?"]) {
      const card = page.getByRole("group", { name });
      await expect(card.getByRole("status")).toHaveText("This request expired. Nothing was deleted.");
      await expect(card.getByRole("button")).toHaveCount(0);
    }
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

  test("a request to delete fits the screen, with long words in it and buttons large enough to tap, in both languages", async ({ page, api }) => {
    for (const locale of ["en", "zh"] as const) {
      api.setSession(sessionWith("edit", locale));
      api.model = MODEL;
      deleteRequests(api, {
        appName: locale === "zh" ? "全家每月按人记录的开支明细与预算对照表" : "Spending of the whole family by month and by person",
        preview: [
          "https://example.com/a/very/long/address/that/someone/pasted/into/a/note/without/any/spaces/at/all",
          "Supercalifragilisticexpialidocious-and-then-some-more-letters-without-a-break",
          "午饭 · 12.50",
          "A note of ordinary length",
          "Another one",
        ],
      });
      await page.goto(`/chat?space=${PERSONAL_SPACE}&chat=chat-tidy`);
      const week = page.getByRole("group", { name: locale === "zh" ? /删除 7 条数据吗？$/ : /^Delete 7 entries from/ });
      await week.scrollIntoViewIfNeeded();
      await expect(week.getByText(locale === "zh" ? "还有 2 条" : "and 2 more")).toBeVisible();
      await expectNothingPastTheEdge(page);
      for (const name of locale === "zh" ? ["删除", "取消"] : ["Delete", "Cancel"]) {
        expect((await week.getByRole("button", { name }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
      await week.getByRole("button", { name: locale === "zh" ? "删除" : "Delete" }).tap();
      await expect(week.getByRole("status")).toHaveText(locale === "zh" ? "已删除 7 条数据。" : "Deleted 7 entries.");
      await expectNothingPastTheEdge(page);
    }
  });
});
