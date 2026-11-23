/**
 * The chat keeps its conversations (docs/platform.md, "The chat"), against
 * the real server: the owner saves a model in Settings, switches the
 * assistant on for their own space where the chat page offers it, and talks
 * to it. Every copy of the server asks the stand-in model
 * (e2e/model-stand-in.ts) in place of the one chosen, which answers
 * "Noted: " and the message; nothing reaches a real model. What is said is
 * kept on the server: listed, opened again after a reload, continued,
 * started afresh and deleted. And it is the person's alone: in a group the
 * owner shares with Lin, the owner's conversation is not in her list.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MEMBER_EMAIL, MEMBER_URL } from "./servers.ts";

// They share the owner's model and the assistant's switch of the owner's space.
test.describe.configure({ mode: "serial" });

/** What the tests read of a session. */
type SessionNow = { user: { id: string }; spaces: { id: string; kind: string; name: string; assistant: string }[] };

async function sessionOf(api: APIRequestContext): Promise<SessionNow> {
  return (await (await api.get("/api/session")).json()) as SessionNow;
}

/** The person's conversations in a space, as the server lists them: the one used last first. */
async function chatsOf(api: APIRequestContext, spaceId: string): Promise<{ id: string; title: string }[]> {
  const answer = await api.get(`/api/spaces/${spaceId}/chats`);
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { chats: { id: string; title: string }[] }).chats;
}

/** Deletes every conversation the person has in a space, such as what an earlier run against the same server left. */
async function forgetChats(api: APIRequestContext, spaceId: string): Promise<void> {
  for (const chat of await chatsOf(api, spaceId)) expect((await api.delete(`/api/spaces/${spaceId}/chats/${chat.id}`)).status()).toBe(204);
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

/** Writes a message in the open conversation and waits for the stand-in model's answer. */
async function say(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message your model" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(`Noted: ${text}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
}

/** The list of conversations beside the open one, on a wide screen. */
const listOn = (page: Page) => page.getByRole("navigation", { name: "Conversations" });

test("the owner's conversations are kept: listed, opened again after a reload, continued, started afresh and deleted", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const problems = watchForProblems(page);
  const personal = (await sessionOf(request)).spaces.find((space) => space.kind === "personal");
  expect(personal).toBeDefined();
  const personalId = personal?.id ?? "";
  const levelBefore = personal?.assistant ?? "none";
  // From the start, whatever an earlier run against the same server left: no model, the assistant off, no conversations.
  expect((await request.delete("/api/me/model")).status()).toBe(204);
  expect((await request.put(`/api/spaces/${personalId}/assistant`, { data: { level: "none" } })).status()).toBe(204);
  await forgetChats(request, personalId);

  try {
    // Without a model, the chat asks for one first.
    await page.goto("/chat");
    await page.getByRole("link", { name: "Choose your model" }).click();
    await expect(page).toHaveURL(/\/settings$/);

    // The owner saves a model in Settings: any OpenAI-compatible service, with a made-up key.
    const model = page.locator("section", { has: page.getByRole("heading", { name: "Your model" }) });
    await model.getByRole("button", { name: "OpenAI-compatible" }).click();
    await model.getByLabel("Address").fill("https://api.example.com/v1");
    await model.getByLabel("Model", { exact: true }).fill("sample-model");
    await model.getByLabel("API key").fill("sample-key-not-a-real-one");
    await model.getByRole("button", { name: "Save" }).click();
    await expect(model.getByRole("status")).toHaveText("Saved");

    // The assistant is off in the owner's space: the chat page offers to allow it.
    await page.goto("/chat");
    await expect(listOn(page).getByText("No conversations here yet.")).toBeVisible();
    await page.getByRole("button", { name: "Allow it here" }).click();
    await expect(page.getByRole("button", { name: "Allow it here" })).toBeHidden();

    // The first message starts a conversation, named after it, whose ID goes into the address.
    const first = "Remember that the plumber comes on Tuesday";
    await say(page, first);
    await expect(page).toHaveURL(/[?&]chat=[^&]+/);
    const firstId = new URL(page.url()).searchParams.get("chat") ?? "";
    await expect(listOn(page).getByRole("link", { name: new RegExp(`^${first}`) })).toHaveAttribute("aria-current", "page");
    expect(await chatsOf(request, personalId)).toEqual([expect.objectContaining({ id: firstId, title: first })]);

    // A reload keeps it open, with both messages, read back from the server.
    await page.reload();
    await expect(page.getByText(first, { exact: true })).toBeVisible();
    await expect(page.getByText(`Noted: ${first}`)).toBeVisible();
    await expect(listOn(page).getByRole("link", { name: new RegExp(`^${first}`) })).toHaveAttribute("aria-current", "page");

    // It goes on where it was.
    const more = "And the electrician on Friday";
    await say(page, more);
    expect(new URL(page.url()).searchParams.get("chat")).toBe(firstId);
    await page.reload();
    await expect(page.getByText(`Noted: ${more}`)).toBeVisible();
    await expect(page.getByText(`Noted: ${first}`)).toBeVisible();

    // A new conversation starts empty and goes first in the list.
    await listOn(page).getByRole("button", { name: "New conversation" }).click();
    await expect(page).not.toHaveURL(/[?&]chat=/);
    await expect(page.getByText(`Noted: ${first}`)).toBeHidden();
    const second = "Buy stamps";
    await say(page, second);
    const secondId = new URL(page.url()).searchParams.get("chat") ?? "";
    expect(secondId).not.toBe(firstId);
    await expect(listOn(page).getByRole("link")).toHaveText([new RegExp(`^${second}`), new RegExp(`^${first}`)]);

    // Deleting the first asks first, then it is gone, here and on the server. With the keyboard: Cancel
    // gives focus back to the delete button, and once the conversation is deleted, New conversation has it.
    const deleteFirst = listOn(page).getByRole("button", { name: `Delete conversation ${first}` });
    await deleteFirst.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("dialog", { name: "Delete this conversation?" });
    await expect(confirm.getByText("It cannot be undone. What the model made stays.")).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(deleteFirst).toBeFocused();
    await page.keyboard.press("Enter");
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(listOn(page).getByRole("button", { name: "New conversation" })).toBeFocused();
    await expect(listOn(page).getByRole("link")).toHaveText([new RegExp(`^${second}`)]);
    expect((await chatsOf(request, personalId)).map((chat) => chat.id)).toEqual([secondId]);
    expect((await request.get(`/api/spaces/${personalId}/chats/${firstId}`)).status()).toBe(404);

    // The one still open stays open.
    await expect(page.getByText(`Noted: ${second}`)).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    // Put things back for whoever runs next against the same server.
    await forgetChats(request, personalId);
    await request.put(`/api/spaces/${personalId}/assistant`, { data: { level: levelBefore } });
    await request.delete("/api/me/model");
  }
});

test("a conversation in a group is its writer's alone: Lin, in the same group, sees none of the owner's", async ({
  page,
  request,
  browser,
  playwright,
}) => {
  test.setTimeout(60_000);
  // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
  const groupName = `Chat family ${Date.now().toString(36)}`;
  const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
  const linContext = await browser.newContext({ baseURL: MEMBER_URL });
  const linPage = await linContext.newPage();
  let groupId = "";
  let linId = "";

  try {
    // The owner creates a group and adds Lin, who joins when she first opens Hearth (at once, if an earlier test introduced her).
    const created = await request.post("/api/spaces", { data: { name: groupName } });
    expect(created.status()).toBe(201);
    groupId = ((await created.json()) as { id: string }).id;
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
    const linSession = await sessionOf(linApi);
    linId = linSession.user.id;
    expect(linSession.spaces.map((space) => space.id)).toContain(groupId);
    // The assistant may work in the group.
    expect((await request.put(`/api/spaces/${groupId}/assistant`, { data: { level: "edit" } })).status()).toBe(204);
    expect(
      (await request.put("/api/me/model", { data: { protocol: "openai", baseUrl: "https://api.example.com/v1", model: "sample-model", apiKey: "sample-key-not-a-real-one" } })).status(),
    ).toBe(200);

    // The owner talks to their model in the group.
    const said = "Plan the family dinner for Saturday";
    await page.goto(`/chat?space=${groupId}`);
    await say(page, said);
    const ownerChat = new URL(page.url()).searchParams.get("chat") ?? "";
    expect((await chatsOf(request, groupId)).map((chat) => chat.id)).toEqual([ownerChat]);

    // Lin, in the same group, has no conversations there, and cannot open the owner's, even by its address.
    expect(await chatsOf(linApi, groupId)).toEqual([]);
    expect((await linApi.get(`/api/spaces/${groupId}/chats/${ownerChat}`)).status()).toBe(404);
    expect((await linApi.delete(`/api/spaces/${groupId}/chats/${ownerChat}`)).status()).toBe(404);
    expect((await linApi.post("/api/chat", { data: { spaceId: groupId, chatId: ownerChat, message: "Hello" } })).status()).toBe(404);
    await linPage.goto(`/chat?space=${groupId}`);
    await expect(linPage.getByRole("navigation", { name: "Conversations" }).getByText("No conversations here yet.")).toBeVisible();
    await linPage.goto(`/chat?space=${groupId}&chat=${ownerChat}`);
    await expect(linPage.getByText("This conversation is gone.")).toBeVisible();
    await expect(linPage.getByText(said)).toHaveCount(0);
    // The owner's is still there, untouched.
    expect((await chatsOf(request, groupId)).map((chat) => chat.id)).toEqual([ownerChat]);
  } finally {
    // The group stays (nothing deletes a space), without Lin, the owner's conversations or model.
    if (groupId) {
      await forgetChats(request, groupId);
      if (linId) await request.delete(`/api/spaces/${groupId}/members/${linId}`);
    }
    await request.delete("/api/me/model");
    await linContext.close();
    await linApi.dispose();
  }
});
