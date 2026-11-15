/**
 * The assistant end to end (docs/mini-app-contract.md, section F, build
 * step F4), against the real server: the owner's and Lin's copies over one
 * database (see playwright.config.ts). The owner switches a group of their
 * own on in Settings; Claude is played by the official MCP client in this
 * test's own process, signed in as each of them by their copy of the
 * server. Everything here happens in a group made for the test, so that
 * the other tests on this server, which share it, are not disturbed.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import { PHONE, expectNothingPastTheEdge } from "./fixtures.ts";
import { MEMBER_EMAIL, MEMBER_URL, OWNER_URL } from "./servers.ts";

test.describe.configure({ mode: "serial" });

const clients: Client[] = [];

test.afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** Claude, connected to one copy of the server, as the person that copy signs everyone in as. */
async function claudeAt(url: string): Promise<Client> {
  const client = new Client({ name: "hearth-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  clients.push(client);
  return client;
}

/**
 * The person's tools as the server lists them now. Hearth lets a client keep
 * the list for a minute (`ttlMs`), as Claude keeps its own for longer; this
 * asks again, as "Refresh tools list" in Claude does.
 */
async function tools(client: Client) {
  return (await client.listTools(undefined, { cacheMode: "refresh" })).tools;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await tools(client)).map((tool) => tool.name);
}

/** The text a call answered with, and whether it failed. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { text: first?.text ?? "", failed: result.isError === true };
}

test("Claude reads and changes a group's checklist only as far as its owners allow", async ({ page, request }) => {
  // Names of their own, so that what an earlier run left on a reused server is not taken for this.
  const run = Date.now().toString(36);
  const groupName = `Assistant ${run}`;
  const item = `Oat milk ${run}`;
  const owner = (await (await request.get("/api/session")).json()) as { user: { id: string } };

  // A group with the checklist, which every member may view, and Lin in it.
  const created = await request.post("/api/spaces", { data: { name: groupName } });
  expect(created.status()).toBe(201);
  const groupId = ((await created.json()) as { id: string }).id;
  expect((await request.put(`/api/spaces/${groupId}/apps/checklist`, { data: { memberAccess: "view" } })).status()).toBe(204);
  expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);

  try {
    // While the group is Off, Claude gets nothing of it, and hearth-spaces says why.
    const ownersClaude = await claudeAt(OWNER_URL);
    expect((await tools(ownersClaude)).every((tool) => !JSON.stringify(tool.inputSchema).includes(groupName))).toBe(true);
    const report = JSON.parse((await call(ownersClaude, "hearth-spaces", {})).text) as {
      spaces: { space: string; assistant: string; note?: string }[];
    };
    expect(report.spaces.find((space) => space.space === groupName)).toMatchObject({
      assistant: "Off",
      note: expect.stringContaining("switch it on, in Hearth's Settings"),
    });

    // The owner switches the group on in Settings, where the card gives this server's address.
    await page.goto("/settings");
    const card = page.getByRole("main").getByRole("region", { name: "Assistant", exact: true });
    await expect(card.getByRole("textbox", { name: "Address for Claude" })).toHaveValue(`${OWNER_URL}/mcp`);
    const row = card.getByTestId(`assistant-space-${groupId}`);
    await row.getByRole("group", { name: `What Claude may do in ${groupName}` }).getByRole("button", { name: "Read and change" }).click();
    await expect(row.getByRole("checkbox", { name: "Checklist" })).toBeChecked();

    // Claude adds to the checklist as the owner, and the web app reads it.
    const add = (await tools(ownersClaude)).find((tool) => tool.name === "checklist_add");
    expect(add?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(JSON.stringify(add?.inputSchema)).toContain(JSON.stringify(groupName));
    const added = await call(ownersClaude, "checklist_add", { space: groupName, input: { name: item } });
    expect(added.failed).toBe(false);
    const listed = await request.post(`/api/spaces/${groupId}/apps/checklist/q/list`, { data: {} });
    expect(((await listed.json()) as { output: { name: string; createdBy: string }[] }).output).toEqual([
      expect.objectContaining({ name: item, createdBy: owner.user.id }),
    ]);

    // Lin may only view the checklist, so her Claude may only read it.
    const linsClaude = await claudeAt(MEMBER_URL);
    const linsTools = await toolNames(linsClaude);
    expect(linsTools).toContain("checklist_list");
    expect(linsTools).not.toContain("checklist_add");
    expect((await call(linsClaude, "checklist_list", { space: groupName })).text).toContain(item);
    expect(await call(linsClaude, "checklist_add", { space: groupName, input: { name: "Lin's idea" } })).toMatchObject({
      failed: true,
      text: expect.stringContaining("Hearth offers checklist_add to this person in no space now"),
    });

    // Read only stops the owner's Claude from changing anything there too.
    await row.getByRole("button", { name: "Read only" }).click();
    await expect.poll(async () => (await toolNames(ownersClaude)).includes("checklist_add")).toBe(false);
    expect((await call(ownersClaude, "checklist_list", { space: groupName })).failed).toBe(false);

    // Leaving the checklist out takes it away altogether.
    // The box follows the saved list, which changes a moment after the press.
    await row.getByRole("checkbox", { name: "Checklist" }).click();
    await expect(row.getByRole("checkbox", { name: "Checklist" })).not.toBeChecked();
    expect(await call(ownersClaude, "checklist_list", { space: groupName })).toMatchObject({ failed: true });
  } finally {
    // Off again, so that a later run on a reused server meets the group as this one did.
    await request.put(`/api/spaces/${groupId}/assistant`, { data: { level: "none" } });
  }
});

test("the Assistant card fits a phone's screen", async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE, baseURL: OWNER_URL });
  const page = await context.newPage();
  try {
    await page.goto("/settings");
    const card = page.getByRole("main").getByRole("region", { name: "Assistant", exact: true });
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("link", { name: "Add to Claude" })).toBeVisible();
    await expectNothingPastTheEdge(page);
  } finally {
    await context.close();
  }
});
