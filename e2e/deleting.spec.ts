/**
 * Deleting, against the real server (docs/platform.md, the owner's decision
 * 7): the model never deletes by itself. Asked in the chat to delete an
 * entry, the stand-in model (e2e/model-stand-in.ts) finds its row and asks
 * to delete it, and the conversation shows a card: nothing goes until the
 * person presses Delete there, and Cancel keeps it. Either way the card says
 * so after a reload, and the model is told with the person's next message.
 * And on the Apps page an owner brings back an app the space removed, and
 * deletes another for good, after typing its name, with everything it held.
 * And the only person in a group leaves it, after typing its name, which
 * deletes the group with everything in it. Each test works in a group of its
 * own and puts the owner's model back; the first two leave theirs, emptied,
 * for the server's later tests.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// They share the owner's model and dashboard.
test.describe.configure({ mode: "serial" });

type SessionNow = { spaces: { id: string; name: string }[]; apps: { id: string; spaceId: string }[] };

async function sessionOf(api: APIRequestContext): Promise<SessionNow> {
  return (await (await api.get("/api/session")).json()) as SessionNow;
}

/** Collects script errors and anything else the browser logs as an error. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

/** A group of the owner's own, with a name no earlier run against the same server gave one. */
async function newGroup(api: APIRequestContext, name: string): Promise<string> {
  const created = await api.post("/api/spaces", { data: { name } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** Adds a built-in app to a space and gives the ID of the app it makes there. */
async function addBuiltIn(api: APIRequestContext, spaceId: string, template: string): Promise<string> {
  const added = await api.post(`/api/spaces/${spaceId}/catalog/${template}`, { data: {} });
  expect(added.status()).toBe(201);
  return ((await added.json()) as { appId: string }).appId;
}

/** The rows of one collection of an app, oldest first; null once the space has no such app. */
async function rowsOf(api: APIRequestContext, spaceId: string, appId: string, collection: string): Promise<Record<string, unknown>[] | null> {
  const answer = await api.get(`/api/spaces/${spaceId}/apps/${appId}/rows/${collection}?orderBy=createdAt`);
  if (answer.status() === 404) return null;
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { rows: Record<string, unknown>[] }).rows;
}

/** What the space's owners' list holds: every app it has, removed ones too. */
async function ownersList(api: APIRequestContext, spaceId: string): Promise<{ id: string; removedAt: string | null; rowCount: number; name?: { en: string } }[]> {
  return ((await (await api.get(`/api/spaces/${spaceId}/apps`)).json()) as { apps: { id: string; removedAt: string | null; rowCount: number; name?: { en: string } }[] })
    .apps;
}

/** Deletes for good every app a space still has, in use or removed, as an owner does on the Apps page. */
async function deleteEveryApp(api: APIRequestContext, spaceId: string): Promise<void> {
  for (const entry of await ownersList(api, spaceId)) {
    await api.delete(`/api/spaces/${spaceId}/apps/${entry.id}/data`, { data: { confirm: entry.name?.en ?? entry.id } });
  }
}

/** Writes a message in the open conversation and waits for the stand-in model's last words, which only its answer holds. */
async function say(page: Page, text: string, answer: string | RegExp): Promise<void> {
  await page.getByRole("textbox", { name: "Message your model" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(answer)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
}

test("the model asks before it deletes: the owner confirms in the card and the entry goes, cancels the next and it stays, and the model is told each answer", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const milk = `Milk ${stamp}`;
  const bread = `Bread ${stamp}`;
  const problems = watchForProblems(page);
  let groupId = "";

  try {
    // A group whose assistant may change things, with the grocery list and two items on it, and the owner's model.
    groupId = await newGroup(request, `Deleting ${stamp}`);
    expect((await request.put(`/api/spaces/${groupId}/assistant`, { data: { level: "edit" } })).status()).toBe(204);
    expect(
      (await request.put("/api/me/model", { data: { protocol: "openai", baseUrl: "https://api.example.com/v1", model: "sample-model", apiKey: "sample-key-not-a-real-one" } })).status(),
    ).toBe(200);
    const appId = await addBuiltIn(request, groupId, "grocery");
    for (const name of [milk, bread]) {
      expect((await request.post(`/api/spaces/${groupId}/apps/${appId}/rows/items`, { data: { data: { name, aisle: "", done: false } } })).status()).toBe(201);
    }
    const names = async () => (await rowsOf(request, groupId, appId, "items"))?.map((row) => row.name);

    // Asked to delete the milk, the model finds its row and asks: the card names what would go, and nothing has gone yet.
    await page.goto(`/chat?space=${groupId}`);
    await say(page, `delete ${milk}`, `Asked before deleting ${milk}`);
    const chatId = new URL(page.url()).searchParams.get("chat") ?? "";
    const cards = page.getByRole("group", { name: "Delete 1 entry from “Grocery list”?" });
    const milkCard = cards.filter({ hasText: milk });
    await expect(milkCard.getByRole("listitem")).toHaveText([milk]);
    expect(await names()).toEqual([milk, bread]);

    // Delete: it goes, and the card says so, without its buttons.
    await milkCard.getByRole("button", { name: "Delete" }).click();
    await expect(milkCard.getByRole("status")).toHaveText("Deleted 1 entry.");
    await expect(milkCard.getByRole("button")).toHaveCount(0);
    expect(await names()).toEqual([bread]);

    // After a reload, read back from the server, the card still says what became of it.
    await page.reload();
    await expect(milkCard.getByRole("status")).toHaveText("Deleted 1 entry.");
    await expect(milkCard.getByRole("button")).toHaveCount(0);

    // With the next message the model is told, in Hearth's words before the person's (the stand-in says back all it got).
    await say(page, "Thanks", /^Noted: \[Hearth: the person confirmed deleting 1 entry from .Grocery list. \(collection .items.\)\. Do not ask again\.\]$/);

    // Asked to delete the bread too, the owner cancels: it stays.
    await say(page, `delete ${bread}`, `Asked before deleting ${bread}`);
    const breadCard = cards.filter({ hasText: bread });
    await breadCard.getByRole("button", { name: "Cancel" }).click();
    await expect(breadCard.getByRole("status")).toHaveText("Kept: nothing was deleted.");
    await expect(breadCard.getByRole("button")).toHaveCount(0);
    expect(await names()).toEqual([bread]);

    // The model is told that too, and only that: the earlier answer was told once, before the message after it.
    await say(page, "All right", /^Noted: \[Hearth: the person declined deleting 1 entry from .Grocery list. \(collection .items.\); nothing was deleted\./);
    await expect(page.getByText(/the person confirmed deleting/)).toHaveCount(1);

    // An answered request cannot be answered again, and someone else's answer would not be taken either: the server keeps the first.
    const chat = (await (await request.get(`/api/spaces/${groupId}/chats/${chatId}`)).json()) as {
      entries: { kind: string; action?: string; confirmationId?: string; status?: string; deleted?: number }[];
    };
    const asked = chat.entries.filter((entry) => entry.action === "delete_requested");
    expect(asked.map(({ status, deleted }) => ({ status, deleted }))).toEqual([
      { status: "confirmed", deleted: 1 },
      { status: "declined", deleted: 0 },
    ]);
    const again = await request.post(`/api/spaces/${groupId}/chats/${chatId}/confirmations/${asked[1]?.confirmationId}`, { data: { decision: "confirm" } });
    expect(again.status()).toBe(409);
    expect(await names()).toEqual([bread]);
    expect(problems).toEqual([]);
  } finally {
    // The group stays, without its app or conversations; the owner has no model again.
    if (groupId) {
      for (const chat of ((await (await request.get(`/api/spaces/${groupId}/chats`)).json()) as { chats: { id: string }[] }).chats) {
        await request.delete(`/api/spaces/${groupId}/chats/${chat.id}`);
      }
      await deleteEveryApp(request, groupId);
    }
    await request.delete("/api/me/model");
  }
  expect((await sessionOf(request)).apps.filter((app) => app.spaceId === groupId)).toEqual([]);
});

test("on the Apps page an owner brings back a removed app, and deletes apps for good once their name is typed, with all they held", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const groupName = `Keeping ${stamp}`;
  const problems = watchForProblems(page);
  const card = page.getByRole("main").getByRole("region", { name: groupName });
  let groupId = "";

  try {
    // A group with the grocery list, two items on it, and Ideas, one idea in it, both removed: their data is kept.
    groupId = await newGroup(request, groupName);
    const groceryId = await addBuiltIn(request, groupId, "grocery");
    const ideasId = await addBuiltIn(request, groupId, "ideas");
    for (const name of [`Apples ${stamp}`, `Pears ${stamp}`]) {
      expect((await request.post(`/api/spaces/${groupId}/apps/${groceryId}/rows/items`, { data: { data: { name, aisle: "", done: false } } })).status()).toBe(201);
    }
    const idea = { text: `Paint the fence ${stamp}`, pinned: false, archived: false, tags: [] };
    expect((await request.post(`/api/spaces/${groupId}/apps/${ideasId}/rows/ideas`, { data: { data: idea } })).status()).toBe(201);
    for (const appId of [groceryId, ideasId]) expect((await request.delete(`/api/spaces/${groupId}/apps/${appId}`)).status()).toBe(204);

    // The Apps page lists both under Removed apps, with how many entries each holds.
    await page.goto("/apps");
    const removed = card.getByRole("list", { name: "Removed apps" });
    await expect(removed.getByRole("listitem")).toHaveCount(2);
    await expect(removed.getByRole("listitem").filter({ hasText: "Grocery list" }).getByText("2 entries")).toBeVisible();
    await expect(removed.getByRole("listitem").filter({ hasText: "Ideas" }).getByText("1 entry")).toBeVisible();

    // Bring back: the grocery list is in use again, with its items, for the owners alone.
    await card.getByRole("button", { name: `Bring back Grocery list in ${groupName}` }).click();
    const back = page.getByRole("dialog", { name: `Bring back Grocery list in ${groupName}?` });
    await expect(back.getByText("It comes back with its data, 2 saved entries, and its settings.")).toBeVisible();
    await expect(back.getByRole("radio", { name: "Only me for now" })).toBeChecked();
    await back.getByRole("button", { name: "Bring back", exact: true }).click();
    await expect(back).toBeHidden();
    await expect(card.getByText("Grocery list is back.")).toBeFocused();
    await expect(card.getByRole("switch", { name: `Show Grocery list in ${groupName}` })).toBeChecked();
    expect(await rowsOf(request, groupId, groceryId, "items")).toHaveLength(2);
    await expect(removed.getByRole("listitem")).toHaveCount(1);

    // Delete Ideas for good: the dialog says what goes, for whom, that it cannot be undone, and wants its name.
    await card.getByRole("button", { name: `Delete permanently: Ideas in ${groupName}` }).click();
    let dialog = page.getByRole("dialog", { name: "Delete Ideas for good?" });
    await expect(dialog.getByText(`Its 1 entry, its settings and its versions are deleted for everyone in ${groupName}. This cannot be undone.`)).toBeVisible();
    const confirmIdeas = dialog.getByRole("button", { name: "Delete", exact: true });
    await expect(confirmIdeas).toBeDisabled();
    await dialog.getByLabel("Type “Ideas” to confirm").fill("Idea");
    await expect(confirmIdeas).toBeDisabled();
    await dialog.getByLabel("Type “Ideas” to confirm").fill("Ideas");
    await confirmIdeas.click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText("Ideas was deleted.")).toBeFocused();
    // Nothing of it is left: not in the owners' list, and its rows are not there to read.
    expect((await ownersList(request, groupId)).map((entry) => entry.id)).toEqual([groceryId]);
    expect(await rowsOf(request, groupId, ideasId, "ideas")).toBeNull();
    await expect(card.getByRole("list", { name: "Removed apps" })).toHaveCount(0);

    // An app in use is deleted for good from its Remove dialog, the same way; spaces around the name do not count.
    await card.getByRole("button", { name: `Remove Grocery list in ${groupName}` }).click();
    await page.getByRole("dialog", { name: `Remove Grocery list in ${groupName}?` }).getByRole("button", { name: "Delete permanently" }).click();
    dialog = page.getByRole("dialog", { name: "Delete Grocery list for good?" });
    await expect(dialog.getByText(`Its 2 entries, its settings and its versions are deleted for everyone in ${groupName}. This cannot be undone.`)).toBeVisible();
    await dialog.getByLabel("Type “Grocery list” to confirm").fill(" Grocery list ");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText("Grocery list was deleted.")).toBeFocused();
    await expect(card.getByText("No apps in this space yet.")).toBeVisible();
    expect(await ownersList(request, groupId)).toEqual([]);
    expect(await rowsOf(request, groupId, groceryId, "items")).toBeNull();
    expect((await sessionOf(request)).apps.filter((app) => app.spaceId === groupId)).toEqual([]);

    // The server asks for the name too, whatever the page does: a wrong one is refused.
    const again = await addBuiltIn(request, groupId, "grocery");
    const wrong = await request.delete(`/api/spaces/${groupId}/apps/${again}/data`, { data: { confirm: "Groceries" } });
    expect(wrong.status()).toBe(400);
    expect(await rowsOf(request, groupId, again, "items")).toEqual([]);
    expect(problems).toEqual([]);
  } finally {
    // The group stays, with nothing in it.
    if (groupId) await deleteEveryApp(request, groupId);
  }
  expect((await sessionOf(request)).apps.filter((app) => app.spaceId === groupId)).toEqual([]);
});

test("the only person in a group leaves it once they have typed its name, and the group goes with everything in it", async ({ page, request }) => {
  test.setTimeout(60_000);
  const stamp = Date.now().toString(36);
  const groupName = `Leaving ${stamp}`;
  const problems = watchForProblems(page);
  let groupId = "";

  try {
    // A group of the owner's alone, with the grocery list and an item on it, and someone invited who has not arrived.
    groupId = await newGroup(request, groupName);
    const appId = await addBuiltIn(request, groupId, "grocery");
    expect((await request.post(`/api/spaces/${groupId}/apps/${appId}/rows/items`, { data: { data: { name: `Milk ${stamp}`, aisle: "", done: false } } })).status()).toBe(201);
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: `invited-${stamp}@example.com` } })).status()).toBe(200);
    const ownerId = ((await (await request.get("/api/session")).json()) as { user: { id: string } }).user.id;
    const leave = `/api/spaces/${groupId}/members/${ownerId}`;

    // The server wants the group's name, whatever the page does: without it, or with another, nothing goes.
    for (const attempt of [await request.delete(leave), await request.delete(leave, { data: { confirm: groupName.toUpperCase() } })]) {
      expect(attempt.status()).toBe(409);
      expect(((await attempt.json()) as { error: { code: string } }).error.code).toBe("confirm_required");
    }
    expect((await request.delete(leave, { data: { confirm: groupName, also: true } })).status()).toBe(400);
    expect(await rowsOf(request, groupId, appId, "items")).toHaveLength(1);
    expect((await sessionOf(request)).spaces.map((space) => space.id)).toContain(groupId);

    // In Settings, Leave asks to delete the group, says what goes, and wants its name typed.
    await page.goto("/settings");
    const card = page.getByRole("main").getByRole("region", { name: groupName });
    await card.getByRole("button", { name: "Leave the group" }).click();
    const dialog = page.getByRole("dialog", { name: `Leave and delete ${groupName}?` });
    await expect(dialog.getByRole("listitem")).toHaveText(["its app, with all its data", "your conversations in it", "its pending invitation"]);
    const confirm = dialog.getByRole("button", { name: "Leave and delete" });
    await dialog.getByLabel(`Type “${groupName}” to confirm`).fill(groupName.slice(0, -1));
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type “${groupName}” to confirm`).fill(groupName);
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("region", { name: "Groups" }).getByText(`${groupName} was deleted.`)).toBeFocused();

    // Nothing of it is left: not in the session, and its owners' list and its rows are not there to read.
    const now = await sessionOf(request);
    expect(now.spaces.map((space) => space.id)).not.toContain(groupId);
    expect(now.apps.filter((app) => app.spaceId === groupId)).toEqual([]);
    expect((await request.get(`/api/spaces/${groupId}/apps`)).status()).toBe(404);
    expect(await rowsOf(request, groupId, appId, "items")).toBeNull();
    await page.reload();
    await expect(page.getByRole("main").getByRole("region", { name: groupName })).toHaveCount(0);
    expect(problems).toEqual([]);
    groupId = "";
  } finally {
    // Should the test stop before the group went, it goes now.
    if (groupId) {
      const ownerId = ((await (await request.get("/api/session")).json()) as { user: { id: string } }).user.id;
      await request.delete(`/api/spaces/${groupId}/members/${ownerId}`, { data: { confirm: groupName } });
    }
  }
});
