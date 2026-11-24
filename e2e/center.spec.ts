/**
 * The app center's whole loop (docs/center.md), against the real server:
 * Lin makes an app in the chat of her personal space and publishes it to a
 * group she shares with the owner. The owner, on a phone, finds it in the
 * app center, adds a copy to their personal space and has it renamed in the
 * chat. Lin's app is as it was. Lin unpublishes it, and the owner's copy
 * still works, saying that it is no longer shared. Both chats ask the
 * stand-in model (e2e/model-stand-in.ts), which makes and renames an app
 * when asked in its words; nothing reaches a real model.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PHONE, expectNothingPastTheEdge, sandbox } from "./fixtures.ts";
import { MEMBER_EMAIL, MEMBER_URL } from "./servers.ts";

// The owner draws made apps and collects page errors: see docs/notes/e2e.md on service workers.
test.use({ ...PHONE, serviceWorkers: "allow" });

/** What the test reads of a session. */
type SessionNow = {
  user: { id: string };
  spaces: { id: string; kind: string; name: string; assistant: string }[];
  apps: { id: string; spaceId: string; name: { en: string }; version?: number; source?: { listingId?: string; by?: string } }[];
};

async function sessionOf(api: APIRequestContext): Promise<SessionNow> {
  return (await (await api.get("/api/session")).json()) as SessionNow;
}

/** The person's personal space. */
function personalOf(session: SessionNow): SessionNow["spaces"][number] {
  const personal = session.spaces.find((space) => space.kind === "personal");
  expect(personal).toBeDefined();
  return personal!;
}

/** The IDs of the person's conversations in a space. */
async function chatIdsOf(api: APIRequestContext, spaceId: string): Promise<string[]> {
  return ((await (await api.get(`/api/spaces/${spaceId}/chats`)).json()) as { chats: { id: string }[] }).chats.map((chat) => chat.id);
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

/** Sends what the message box holds and waits for the stand-in model's last words. */
async function send(page: Page, answer: string): Promise<void> {
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
}

const MODEL = { protocol: "openai", baseUrl: "https://api.example.com/v1", model: "sample-model", apiKey: "sample-key-not-a-real-one" };

test("Lin publishes an app she made; the owner adds a copy on a phone and changes it in the chat; once she unpublishes, the copy still works", async ({
  page,
  request,
  browser,
  playwright,
}) => {
  test.setTimeout(90_000);
  // Names of their own, so that what an earlier run left on a reused server is not taken for this run's.
  const stamp = Date.now().toString(36);
  const groupName = `Center ${stamp}`;
  const appName = `Ledger ${stamp}`;
  const renamed = `Home ledger ${stamp}`;
  const problems = watchForProblems(page);
  const linApi = await playwright.request.newContext({ baseURL: MEMBER_URL });
  const linContext = await browser.newContext({ baseURL: MEMBER_URL, serviceWorkers: "allow" });
  const linPage = await linContext.newPage();
  const linProblems = watchForProblems(linPage);
  let groupId = "";
  let linId = "";
  let ownerSpace: SessionNow["spaces"][number] | undefined;
  let linSpace: SessionNow["spaces"][number] | undefined;
  let ownerChatsBefore: string[] = [];
  let linChatsBefore: string[] = [];
  let linAppId = "";
  let copyId = "";

  try {
    // The owner makes a group and adds Lin, who joins when she first opens Hearth (at once, if an earlier test introduced her).
    const created = await request.post("/api/spaces", { data: { name: groupName } });
    expect(created.status()).toBe(201);
    groupId = ((await created.json()) as { id: string }).id;
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
    const linSession = await sessionOf(linApi);
    linId = linSession.user.id;
    expect(linSession.spaces.map((space) => space.id)).toContain(groupId);

    // Each has a model, and lets it change things in their personal space; both are put back at the end.
    ownerSpace = personalOf(await sessionOf(request));
    linSpace = personalOf(linSession);
    ownerChatsBefore = await chatIdsOf(request, ownerSpace.id);
    linChatsBefore = await chatIdsOf(linApi, linSpace.id);
    for (const [api, space] of [
      [request, ownerSpace],
      [linApi, linSpace],
    ] as const) {
      expect((await api.put("/api/me/model", { data: MODEL })).status()).toBe(200);
      expect((await api.put(`/api/spaces/${space.id}/assistant`, { data: { level: "edit" } })).status()).toBe(204);
    }

    // Lin asks her model for an app, in her personal space.
    await linPage.goto(`/chat?space=${linSpace.id}`);
    await linPage.getByRole("textbox", { name: "Message your model" }).fill(`make ${appName}`);
    await send(linPage, `Made ${appName}`);
    linAppId = (await sessionOf(linApi)).apps.find((app) => app.spaceId === linSpace!.id && app.name.en === appName)?.id ?? "";
    expect(linAppId).not.toBe("");

    // She publishes it to the group from its page, after reading what will leave and ticking that nothing is private.
    await linPage.goto(`/apps/${linSpace.id}/${linAppId}`);
    await linPage.getByRole("button", { name: `Publish ${appName}…` }).click();
    const publish = linPage.getByRole("dialog", { name: `Publish “${appName}”` });
    await expect(publish.getByRole("region", { name: "What will be shared" }).getByText("Amounts are in euros.")).toBeVisible();
    await publish.getByRole("radio", { name: groupName }).check();
    await publish.getByRole("textbox", { name: "A note (optional)" }).fill("First go");
    const publishButton = publish.getByRole("button", { name: "Publish", exact: true });
    await expect(publishButton).toBeDisabled();
    await publish.getByRole("checkbox", { name: "I have checked that this holds nothing private" }).check();
    await publishButton.click();
    await expect(publish.getByText(`Published to ${groupName}, revision 1.`)).toBeFocused();

    // The owner, on a phone, finds it in the app center, under the group, by Lin.
    await page.goto("/center");
    const inGroup = page.getByRole("main").getByRole("region", { name: `In ${groupName}` });
    const listing = inGroup.getByRole("listitem").filter({ has: page.getByRole("heading", { name: appName, exact: true }) });
    await expect(listing.getByText(/^By lin, /)).toBeVisible();
    await expect(listing.getByText("Revision 1: First go")).toBeVisible();
    await expect(listing.getByText("It reads and changes only its own entries, and reaches no website.")).toBeVisible();
    await expectNothingPastTheEdge(page);

    // A copy goes into the owner's personal space.
    await listing.getByRole("button", { name: `Add a copy of ${appName}` }).click();
    const add = page.getByRole("dialog", { name: `Add a copy of “${appName}”` });
    await add.getByRole("radio", { name: /Personal/ }).check();
    await expectNothingPastTheEdge(page);
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add.getByText(`A copy of “${appName}” is in your personal space now.`)).toBeFocused();
    const copy = (await sessionOf(request)).apps.find((app) => app.spaceId === ownerSpace!.id && app.source !== undefined);
    copyId = copy?.id ?? "";
    expect(copy).toMatchObject({ name: { en: appName }, version: 1, source: { listingId: expect.any(String), by: "lin" } });
    expect(copyId).not.toBe(linAppId);

    // The chat opens on the copy, with the box begun; the owner finishes the sentence and the model renames it.
    await add.getByRole("link", { name: "Change it in the chat" }).click();
    await expect(page).toHaveURL(new RegExp(`/chat\\?space=${ownerSpace.id}$`));
    const box = page.getByRole("textbox", { name: "Message your model" });
    await expect(box).toHaveValue(`Change “${appName}”: `);
    await box.pressSequentially(`call it ${renamed}`);
    await send(page, `Renamed ${appName} to ${renamed}`);
    await expect(page.getByText(`Changed the app “${renamed}” (version 2)`)).toBeVisible();
    expect((await sessionOf(request)).apps.find((app) => app.id === copyId)).toMatchObject({ name: { en: renamed }, version: 2 });

    // Lin's app is as it was, and so is what is published.
    expect((await sessionOf(linApi)).apps.find((app) => app.id === linAppId)).toMatchObject({ name: { en: appName }, version: 1 });
    const listed = ((await (await request.get("/api/center")).json()) as { listings: { spaceId: string; name: { en: string }; revision: number }[] }).listings;
    expect(listed.filter((entry) => entry.spaceId === groupId)).toEqual([expect.objectContaining({ name: { en: appName, zh: appName }, revision: 1 })]);

    // The copy's page says whose app it was.
    await page.goto(`/apps/${ownerSpace.id}/${copyId}`);
    await expect(page.getByText("A copy of an app lin shared")).toBeVisible();
    await expect(sandbox(page, copyId).getByText("No entries yet.")).toBeVisible();
    await expectNothingPastTheEdge(page);

    // Lin unpublishes it from her app's page.
    await linPage.goto(`/apps/${linSpace.id}/${linAppId}`);
    await linPage.getByRole("button", { name: `Publish ${appName}…` }).click();
    const unpublish = publish.getByRole("button", { name: `Unpublish ${appName} from ${groupName}` });
    await unpublish.click();
    await unpublish.click();
    await expect(publish.getByText(`It is no longer published to ${groupName}. Copies of it keep working.`)).toBeFocused();
    const left = ((await (await request.get("/api/center")).json()) as { listings: { spaceId: string }[] }).listings;
    expect(left.filter((entry) => entry.spaceId === groupId)).toEqual([]);

    // The owner's copy still works: it says it is no longer shared, keeps the change, and shows an entry written now.
    const entry = await request.post(`/api/spaces/${ownerSpace.id}/apps/${copyId}/rows/entries`, { data: { data: { item: "Bread", amount: 3 } } });
    expect(entry.status()).toBe(201);
    await page.reload();
    await expect(page.getByText("A copy of an app that is no longer shared")).toBeVisible();
    const kept = (await sessionOf(request)).apps.find((app) => app.id === copyId);
    expect(kept).toMatchObject({ name: { en: renamed }, version: 2, source: {} });
    expect(kept?.source?.listingId).toBeUndefined();
    await expect(sandbox(page, copyId).getByRole("listitem")).toHaveText(["Bread: 3"]);
    await expect(sandbox(page, copyId).getByText("No entries yet.")).toBeHidden();
    expect(problems).toEqual([]);
    expect(linProblems).toEqual([]);
  } finally {
    // Everything this test made goes, and the models and switches are put back; the group stays, without Lin.
    if (ownerSpace) {
      for (const chatId of await chatIdsOf(request, ownerSpace.id)) {
        if (!ownerChatsBefore.includes(chatId)) await request.delete(`/api/spaces/${ownerSpace.id}/chats/${chatId}`);
      }
      // Deleting for good wants the name it has now, which is the new one only if the model renamed it.
      const copyName = (await sessionOf(request)).apps.find((app) => app.id === copyId)?.name.en;
      if (copyName) await request.delete(`/api/spaces/${ownerSpace.id}/apps/${copyId}/data`, { data: { confirm: copyName } });
      await request.put(`/api/spaces/${ownerSpace.id}/assistant`, { data: { level: ownerSpace.assistant } });
    }
    if (linSpace) {
      for (const chatId of await chatIdsOf(linApi, linSpace.id)) {
        if (!linChatsBefore.includes(chatId)) await linApi.delete(`/api/spaces/${linSpace.id}/chats/${chatId}`);
      }
      if (linAppId) await linApi.delete(`/api/spaces/${linSpace.id}/apps/${linAppId}/data`, { data: { confirm: appName } });
      await linApi.put(`/api/spaces/${linSpace.id}/assistant`, { data: { level: linSpace.assistant } });
    }
    if (groupId && linId) await request.delete(`/api/spaces/${groupId}/members/${linId}`);
    await request.delete("/api/me/model");
    await linApi.delete("/api/me/model");
    await linApi.dispose();
    await linContext.close();
  }
});
