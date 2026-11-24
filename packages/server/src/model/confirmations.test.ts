/**
 * What the model asks before it deletes (docs/platform.md, owner's decision
 * 7). The risks: a row deleted without the person's say; a request answered
 * by someone else, through another conversation or space, or twice; an
 * answer carried out after access was taken away, or after its time ran
 * out; the model asking again because nobody told it the answer; and,
 * deleting a whole app, an app deleted by someone who may not, by a slip,
 * or leaving something of it behind. Nothing here reaches a real model: a
 * fake fetch answers as the service would.
 */
import type { ChatEntry } from "@hearth/shared";
import { describe, expect, it } from "vitest";
import { CHECKLIST, family, grant, JOURNAL, KIM, LIN, makeApp, NOA, SAM } from "../apps/test-world";
import type { Db } from "../db/database";
import { as, testApp, testConfig } from "../testing";
import { previewOf } from "./chat";
import { historyFor } from "./chats";
import { CONFIRMATION_MS, createDeleteRequest, findDeleteRequest, settleDeleteRequest } from "./confirmations";

const SECRET = "a-secret-for-tests-only-32-chars!!";
/** The family's checklist, which Lin may edit and Kim may only view. */
const OURS = "m-ourlist000";
/** The family's journal, beside it. */
const DIARY = "m-ourdiary00";
/** Sam's own checklist, in his personal space. */
const OWN = "m-samslist00";

type Sent = { body: { messages: { role: string; content?: string; tool_call_id?: string }[] } };
type Event = { type: string; [key: string]: unknown };

/** A fetch that answers each request to the model with the next answer, given what was sent. */
function fakeModel(answers: ((sent: Sent) => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = { body: JSON.parse(String(init?.body)) as Sent["body"] };
    sent.push(request);
    const answer = answers[sent.length - 1];
    if (!answer) throw new Error(`The model was asked ${sent.length} times; the test expected ${answers.length}.`);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const openAiAnswer = (message: Record<string, unknown>, finish = "stop") =>
  Response.json({ choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: null, ...message } }] });

/** The model's answer that asks to delete rows. */
const askToDelete = (input: Record<string, unknown>, id = "call_1") => () =>
  openAiAnswer({ tool_calls: [{ id, type: "function", function: { name: "delete_rows", arguments: JSON.stringify(input) } }] }, "tool_calls");
/** The model's answer that ends its turn. */
const say = (text: string) => () => openAiAnswer({ content: text });

/**
 * The family with its checklist and journal, the assistant allowed to change
 * things there, and three items on the list. Each person's model is the fake.
 */
async function world(answers: ((sent: Sent) => Response)[] = []) {
  const people = family();
  const model = fakeModel(answers);
  const { app, db, errors } = testApp({ db: people.db, config: testConfig({ secret: SECRET }), modelFetch: model.fetch });
  const call = (email: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: as(email, body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  makeApp(db, people.family, OURS, people.sam.id, { memberAccess: "edit", createdAt: "2026-01-05T00:00:00.000Z" });
  makeApp(db, people.family, DIARY, people.sam.id, { manifest: JOURNAL, memberAccess: "edit", createdAt: "2026-01-06T00:00:00.000Z" });
  makeApp(db, people.samsSpace, OWN, people.sam.id);
  grant(db, people.family, OURS, people.kim.id, "view", people.sam.id);
  db.prepare("UPDATE spaces SET assistant = 'edit' WHERE id IN (?, ?)").run(people.family, people.samsSpace);
  for (const email of [SAM, LIN, KIM]) {
    const saved = await call(email, "PUT", "/api/me/model", { protocol: "openai", baseUrl: "https://api.example.com/v1", model: "chat-1", apiKey: "sk-test" });
    expect(saved.status).toBe(200);
  }
  const addRow = async (spaceId: string, appId: string, collection: string, data: Record<string, unknown>) => {
    const response = await call(SAM, "POST", `/api/spaces/${spaceId}/apps/${appId}/rows/${collection}`, { data });
    expect(response.status).toBe(201);
    return ((await response.json()) as { row: { id: string } }).row.id;
  };
  const milk = await addRow(people.family, OURS, "items", { name: "Milk", section: "Dairy" });
  const bread = await addRow(people.family, OURS, "items", { name: "Bread" });
  const eggs = await addRow(people.family, OURS, "items", { name: "Eggs" });
  const entry = await addRow(people.family, DIARY, "entries", { text: "A sample day" });

  /** Says something in the family's chat, in a new conversation or the one given, and gives the events after the first. */
  const chat = async (email: string, message: string, chatId?: string, spaceId = people.family) => {
    const response = await call(email, "POST", "/api/chat", { spaceId, message, ...(chatId ? { chatId } : {}) });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Event)
      .filter((event) => event.type !== "ping");
    if (chatId) return Object.assign(events, { chatId });
    expect(events[0]).toMatchObject({ type: "chat" });
    return Object.assign(events.slice(1), { chatId: events[0]!.chatId as string });
  };
  /** The request the model's delete_rows made, from its event. */
  const requestOf = (events: Event[]) => {
    const asked = events.find((event) => event.action === "delete_requested");
    expect(asked, "a request to delete").toBeDefined();
    return asked!.confirmationId as string;
  };
  const answer = (email: string, chatId: string, confirmationId: string, decision: unknown, spaceId = people.family) =>
    call(email, "POST", `/api/spaces/${spaceId}/chats/${chatId}/confirmations/${confirmationId}`, { decision });
  const items = () =>
    (db.prepare("SELECT json_extract(data, '$.name') AS name FROM app_rows WHERE space_id = ? AND app_id = ? ORDER BY created_at, id").all(people.family, OURS) as { name: string }[]).map(
      (row) => row.name,
    );
  const entriesOf = async (email: string, chatId: string, spaceId = people.family) => {
    const response = await call(email, "GET", `/api/spaces/${spaceId}/chats/${chatId}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { entries: ChatEntry[] }).entries;
  };
  const requestEntry = async (email: string, chatId: string) =>
    (await entriesOf(email, chatId)).find((entry) => entry.kind === "action" && entry.action === "delete_requested");
  return { ...people, app, db, errors, model, call, chat, requestOf, answer, items, entriesOf, requestEntry, rows: { milk, bread, eggs, entry } };
}

/** How many rows of a table name the app in the space. */
const countOf = (db: Db, table: string, spaceId: string, appId: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND app_id = ?`).get(spaceId, appId) as { n: number }).n;

describe("the model's request to delete rows", () => {
  it("deletes nothing, keeps the request and shows the person what would go", async () => {
    let told = "";
    let rowIds: string[] = [];
    const w = await world([
      () => askToDelete({ appId: OURS, collection: "items", rowIds })(),
      (sent) => {
        told = sent.body.messages.at(-1)!.content!;
        return say("I asked you to confirm deleting Milk and Bread.")();
      },
    ]);
    // Milk twice: a row named again counts once.
    rowIds = [w.rows.milk, w.rows.bread, w.rows.milk];
    const events = await w.chat(SAM, "Delete milk and bread");
    const chatId = events.chatId;
    expect([...events]).toEqual([
      {
        type: "action",
        action: "delete_requested",
        appId: OURS,
        appName: "Checklist",
        confirmationId: expect.any(String),
        collection: "items",
        count: 2,
        preview: ["Milk · Dairy", "Bread"],
        status: "pending",
      },
      { type: "text", text: "I asked you to confirm deleting Milk and Bread." },
      { type: "done" },
    ]);
    expect(JSON.parse(told)).toMatchObject({ asked: true, count: 2, note: expect.stringMatching(/Nothing is deleted yet/) });
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);

    // Kept with the conversation without where it stands, which is read afresh.
    const stored = w.db.prepare("SELECT data FROM chat_entries WHERE chat_id = ? AND kind = 'action'").get(chatId) as { data: string };
    expect(JSON.parse(stored.data)).not.toHaveProperty("status");
    expect(await w.requestEntry(SAM, chatId)).toMatchObject({ status: "pending", deleted: 0, count: 2 });
    expect(w.db.prepare("SELECT status, row_ids AS rowIds, user_id AS userId FROM chat_confirmations").all()).toEqual([
      { status: "pending", rowIds: JSON.stringify([w.rows.milk, w.rows.bread]), userId: w.sam.id },
    ]);
    expect(w.errors).toEqual([]);
  });

  it("is told to the model as the one way to delete, which never deletes by itself", async () => {
    const w = await world([
      (sent) => {
        const system = sent.body.messages[0]!.content!;
        expect(system).toMatch(/never delete anything yourself/);
        return say("OK")();
      },
    ]);
    await w.chat(SAM, "Hello");
    const tools = (w.model.sent[0]!.body as unknown as { tools: { function: { name: string; description: string } }[] }).tools;
    const tool = tools.find((candidate) => candidate.function.name === "delete_rows");
    expect(tool?.function.description).toMatch(/every deletion/);
    expect(tool?.function.description).toMatch(/deletes nothing by itself/);
  });

  it.each([
    ["a row that is not there", () => ({ appId: OURS, collection: "items", rowIds: ["no-such-row"] }), /no row with the ID "no-such-row"/],
    ["a row of another app", (rows: Record<string, string>) => ({ appId: OURS, collection: "items", rowIds: [rows.entry] }), /no row with the ID/],
    ["a collection the app does not have", (rows: Record<string, string>) => ({ appId: OURS, collection: "entries", rowIds: [rows.milk] }), /no collection "entries"/],
    ["an app of another space", (rows: Record<string, string>) => ({ appId: OWN, collection: "items", rowIds: [rows.milk] }), /no such app/],
    ["more than 50 rows", () => ({ appId: OURS, collection: "items", rowIds: Array.from({ length: 51 }, (_, n) => `row-${n}`) }), /does not fit the tool/],
  ])("is refused for %s, and nothing is kept", async (_label, input, why) => {
    let told = "";
    // The rows' IDs are known once the world is made, before the model is asked.
    let rows: Record<string, string> = {};
    const w = await world([
      () => askToDelete(input(rows))(),
      (sent) => {
        told = sent.body.messages.at(-1)!.content!;
        return say("Could not.")();
      },
    ]);
    rows = w.rows;
    const events = await w.chat(SAM, "Delete it");
    expect(events.map((event) => event.type)).toEqual(["text", "done"]);
    expect(told).toMatch(why);
    expect(w.db.prepare("SELECT count(*) AS n FROM chat_confirmations").get()).toEqual({ n: 0 });
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
  });

  it("is refused for someone who may only view the app, for an app left out of the assistant's, and where it may only read", async () => {
    const told: string[] = [];
    const refusedTurn = [
      askToDelete({ appId: OURS, collection: "items", rowIds: ["x"] }),
      (sent: Sent) => {
        told.push(sent.body.messages.at(-1)!.content!);
        return say("No.")();
      },
    ];
    const w = await world([...refusedTurn, ...refusedTurn, ...refusedTurn]);
    w.db.prepare("UPDATE app_rows SET id = 'x' WHERE id = ?").run(w.rows.milk);
    await w.chat(KIM, "Delete Milk");
    expect(told[0]).toMatch(/yours to view here, not to change/);
    // Sam may edit the list, but its owners left it out of what the assistant may use.
    w.db.prepare("UPDATE space_apps SET assistant = 0 WHERE app_id = ?").run(OURS);
    await w.chat(SAM, "Delete Milk");
    expect(told[1]).toMatch(/no such app, collection or row here/);
    w.db.prepare("UPDATE space_apps SET assistant = 1 WHERE app_id = ?").run(OURS);
    w.db.prepare("UPDATE spaces SET assistant = 'view' WHERE id = ?").run(w.family);
    await w.chat(SAM, "Delete Milk");
    expect(told[2]).toMatch(/switched off in this space/);
    expect(w.db.prepare("SELECT count(*) AS n FROM chat_confirmations").get()).toEqual({ n: 0 });
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
  });
});

describe("the person's answer", () => {
  /** A world where Lin's model asked to delete Milk and Bread in the family, in a conversation of hers. */
  async function asked(more: ((sent: Sent) => Response)[] = []) {
    let rowIds: string[] = [];
    const w = await world([() => askToDelete({ appId: OURS, collection: "items", rowIds })(), say("Please confirm."), ...more]);
    rowIds = [w.rows.milk, w.rows.bread];
    const events = await w.chat(LIN, "Delete milk and bread");
    return { ...w, chatId: events.chatId, confirmationId: w.requestOf(events) };
  }

  it("confirm deletes the rows, once, and the card says so from then on, on every device", async () => {
    const w = await asked();
    const done = await w.answer(LIN, w.chatId, w.confirmationId, "confirm");
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: "confirmed", deleted: 2 });
    expect(w.items()).toEqual(["Eggs"]);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "confirmed", deleted: 2 });

    for (const decision of ["confirm", "decline"]) {
      const again = await w.answer(LIN, w.chatId, w.confirmationId, decision);
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: { code: "conflict", message: "This request was answered already: it is confirmed." } });
    }
    expect(w.db.prepare("SELECT status, deleted, decided_at IS NOT NULL AS decided FROM chat_confirmations").get()).toEqual({
      status: "confirmed",
      deleted: 2,
      decided: 1,
    });
    expect(w.errors).toEqual([]);
  });

  it("decline deletes nothing, and cannot be turned into confirm", async () => {
    const w = await asked();
    const declined = await w.answer(LIN, w.chatId, w.confirmationId, "decline");
    expect(await declined.json()).toEqual({ status: "declined", deleted: 0 });
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
    expect((await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).status).toBe(409);
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "declined", deleted: 0 });
  });

  it("is only the person's own: anyone else, another conversation or another space gets 404, and nothing changes", async () => {
    const w = await asked([say("Hi")]);
    const other = await w.chat(LIN, "Another conversation");
    const tries: [string, string, string, string][] = [
      [SAM, w.family, w.chatId, w.confirmationId],
      [KIM, w.family, w.chatId, w.confirmationId],
      [NOA, w.family, w.chatId, w.confirmationId],
      [LIN, w.family, other.chatId, w.confirmationId],
      [LIN, w.linsSpace, w.chatId, w.confirmationId],
      [LIN, w.family, w.chatId, "no-such-request"],
    ];
    for (const [email, spaceId, chatId, confirmationId] of tries) {
      const response = await w.call(email, "POST", `/api/spaces/${spaceId}/chats/${chatId}/confirmations/${confirmationId}`, { decision: "confirm" });
      expect(response.status, `${email} ${spaceId} ${chatId} ${confirmationId}`).toBe(404);
    }
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "pending" });
  });

  it("takes confirm or decline and nothing else", async () => {
    const w = await asked();
    for (const body of [{}, { decision: "delete" }, { decision: "confirm", rowIds: [] }]) {
      const response = await w.call(LIN, "POST", `/api/spaces/${w.family}/chats/${w.chatId}/confirmations/${w.confirmationId}`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
  });

  it("checks access again when confirmed: taken away, it is refused and the request waits; given back, it goes", async () => {
    const w = await asked();
    // An owner lets Lin only view the list now.
    grant(w.db, w.family, OURS, w.lin.id, "view", w.sam.id);
    const refused = await w.answer(LIN, w.chatId, w.confirmationId, "confirm");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/Nothing was deleted/);
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "pending" });

    // The app left out of what the assistant may use; then removed from the space.
    w.db.prepare("DELETE FROM app_access WHERE user_id = ?").run(w.lin.id);
    w.db.prepare("UPDATE space_apps SET assistant = 0 WHERE app_id = ?").run(OURS);
    expect((await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).status).toBe(403);
    w.db.prepare("UPDATE space_apps SET assistant = 1, removed_at = '2026-02-01T00:00:00.000Z' WHERE app_id = ?").run(OURS);
    expect((await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).status).toBe(403);
    // The space's owners let the assistant only read.
    w.db.prepare("UPDATE space_apps SET removed_at = NULL WHERE app_id = ?").run(OURS);
    w.db.prepare("UPDATE spaces SET assistant = 'view' WHERE id = ?").run(w.family);
    const readOnly = await w.answer(LIN, w.chatId, w.confirmationId, "confirm");
    expect(readOnly.status).toBe(403);
    expect(((await readOnly.json()) as { error: { message: string } }).error.message).toMatch(/owners no longer let the assistant/);
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);

    w.db.prepare("UPDATE spaces SET assistant = 'edit' WHERE id = ?").run(w.family);
    expect(await (await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).json()).toEqual({ status: "confirmed", deleted: 2 });
    expect(w.items()).toEqual(["Eggs"]);
  });

  it("skips the rows deleted meanwhile, and says how many went", async () => {
    const w = await asked();
    expect((await w.call(SAM, "DELETE", `/api/spaces/${w.family}/apps/${OURS}/rows/items/${w.rows.milk}`)).status).toBe(204);
    expect(await (await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).json()).toEqual({ status: "confirmed", deleted: 1 });
    expect(w.items()).toEqual(["Eggs"]);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "confirmed", deleted: 1, count: 2 });
  });

  it("expires after 24 hours: shown so at once, kept so once answered, and nothing deleted", async () => {
    const w = await asked();
    const created = new Date(Date.now() - CONFIRMATION_MS - 60_000).toISOString();
    w.db.prepare("UPDATE chat_confirmations SET created_at = ?").run(created);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "expired", deleted: 0 });
    // Not written until someone acts on it.
    expect(w.db.prepare("SELECT status FROM chat_confirmations").get()).toEqual({ status: "pending" });

    expect(await (await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).json()).toEqual({ status: "expired", deleted: 0 });
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
    expect(w.db.prepare("SELECT status, decided_at AS decidedAt FROM chat_confirmations").get()).toEqual({
      status: "expired",
      decidedAt: new Date(Date.parse(created) + CONFIRMATION_MS).toISOString(),
    });
    expect((await w.answer(LIN, w.chatId, w.confirmationId, "decline")).status).toBe(409);
  });

  it("is not yet expired just before 24 hours", async () => {
    const w = await asked();
    w.db.prepare("UPDATE chat_confirmations SET created_at = ?").run(new Date(Date.now() - CONFIRMATION_MS + 60_000).toISOString());
    expect(await (await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).json()).toEqual({ status: "confirmed", deleted: 2 });
  });

  it("expires when its app is deleted, or moved out of the space", async () => {
    const w = await asked();
    expect((await w.call(SAM, "DELETE", `/api/spaces/${w.family}/apps/${OURS}/data`, { confirm: "Checklist" })).status).toBe(204);
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "expired", deleted: 0 });
    expect((await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).status).toBe(409);

    // A request about the journal, then the journal moved to Sam's own space.
    const again = await world([askToDelete({ appId: DIARY, collection: "entries", rowIds: ["placeholder"] }), say("Confirm?")]);
    again.db.prepare("UPDATE app_rows SET id = 'placeholder' WHERE id = ?").run(again.rows.entry);
    const events = await again.chat(SAM, "Delete the entry");
    const confirmationId = again.requestOf(events);
    expect((await again.call(SAM, "POST", `/api/spaces/${again.family}/apps/${DIARY}/move`, { toSpaceId: again.samsSpace })).status).toBe(204);
    expect(await again.requestEntry(SAM, events.chatId)).toMatchObject({ status: "expired" });
    expect((await again.answer(SAM, events.chatId, confirmationId, "confirm")).status).toBe(409);
    expect(countOf(again.db, "app_rows", again.samsSpace, DIARY)).toBe(1);
  });

  it("expires when answered once its app is not in the space, however it went", async () => {
    const w = await asked();
    // Gone by a way that expires nothing itself, as a later change might add.
    w.db.prepare("DELETE FROM app_rows WHERE app_id = ?").run(OURS);
    w.db.prepare("DELETE FROM space_apps WHERE app_id = ?").run(OURS);
    expect(await (await w.answer(LIN, w.chatId, w.confirmationId, "confirm")).json()).toEqual({ status: "expired", deleted: 0 });
    expect(await w.requestEntry(LIN, w.chatId)).toMatchObject({ status: "expired" });
  });

  it("is told to the model with the person's next message, so that it does not ask again", async () => {
    let history: { role: string; content?: string }[] = [];
    const w = await asked([
      (sent) => {
        history = sent.body.messages.slice(1);
        return say("Done, they are gone.")();
      },
    ]);
    await w.answer(LIN, w.chatId, w.confirmationId, "confirm");
    await w.chat(LIN, "Thanks", w.chatId);
    expect(history).toEqual([
      { role: "user", content: "Delete milk and bread" },
      { role: "assistant", content: "Please confirm." },
      {
        role: "user",
        // Lin reads Hearth in Chinese, so the app is named for her so.
        content: '[Hearth: the person confirmed deleting 2 entries from "清单" (collection "items"). Do not ask again.]\n\nThanks',
      },
    ]);
  });
});

describe("the table's own functions", () => {
  it("settle a request only while it waits, and only the person's own", async () => {
    const w = await world([() => askToDelete({ appId: OURS, collection: "items", rowIds: ["placeholder"] })(), say("Confirm?")]);
    w.db.prepare("UPDATE app_rows SET id = 'placeholder' WHERE id = ?").run(w.rows.milk);
    const events = await w.chat(SAM, "Delete milk");
    const scope = { chatId: events.chatId, spaceId: w.family, userId: w.sam.id, id: w.requestOf(events) };
    const at = "2026-03-01T00:00:00.000Z";
    expect(settleDeleteRequest(w.db, { ...scope, userId: w.lin.id, status: "declined", deleted: null, at })).toBe(false);
    expect(settleDeleteRequest(w.db, { ...scope, status: "confirmed", deleted: 0, at })).toBe(true);
    expect(settleDeleteRequest(w.db, { ...scope, status: "declined", deleted: null, at })).toBe(false);
    expect(findDeleteRequest(w.db, scope)).toMatchObject({ status: "confirmed", deleted: 0, decidedAt: at });
    // A request is kept only beside a conversation of the person's in the space.
    expect(createDeleteRequest(w.db, { ...scope, userId: w.lin.id, appId: OURS, collection: "items", rowIds: ["x"], now: at })).toBeNull();
    expect(createDeleteRequest(w.db, { ...scope, spaceId: w.samsSpace, appId: OURS, collection: "items", rowIds: ["x"], now: at })).toBeNull();
  });
});

describe("historyFor and the answers", () => {
  const request = (status: string, decidedAt: string | null, at = "2026-03-01T00:00:01.000Z") =>
    ({
      kind: "action",
      action: "delete_requested",
      appId: OURS,
      appName: "Ledger",
      confirmationId: "r-1",
      collection: "expenses",
      count: 1,
      preview: ["Lunch"],
      status,
      deleted: status === "confirmed" ? 1 : 0,
      at,
      decidedAt,
    }) as ChatEntry & { at: string; decidedAt: string | null };
  const user = (text: string, at: string) => ({ kind: "user" as const, text, at });
  const model = (text: string, at: string) => ({ kind: "model" as const, text, at });

  it("says nothing of a request that waits", () => {
    expect(historyFor([user("Delete lunch", "2026-03-01T00:00:00.000Z"), request("pending", null), model("Confirm?", "2026-03-01T00:00:02.000Z")])).toEqual([
      { role: "user", content: "Delete lunch" },
      { role: "assistant", content: "Confirm?" },
    ]);
  });

  it("places each answer before the first message of the person's written after it, in order", () => {
    const history = historyFor([
      user("Delete lunch", "2026-03-01T00:00:00.000Z"),
      request("declined", "2026-03-01T00:05:00.000Z"),
      model("Confirm?", "2026-03-01T00:00:02.000Z"),
      user("Wait, what else is there?", "2026-03-01T00:01:00.000Z"),
      model("Coffee.", "2026-03-01T00:01:01.000Z"),
      user("Never mind", "2026-03-01T00:06:00.000Z"),
    ]);
    expect(history).toEqual([
      { role: "user", content: "Delete lunch" },
      { role: "assistant", content: "Confirm?" },
      { role: "user", content: "Wait, what else is there?" },
      { role: "assistant", content: "Coffee." },
      {
        role: "user",
        content: '[Hearth: the person declined deleting 1 entry from "Ledger" (collection "expenses"); nothing was deleted. Do not ask again unless they do.]\n\nNever mind',
      },
    ]);
  });

  it("tells of a request that expired, and of rows gone before the answer", () => {
    // With nothing the model said between, the person's side is one message.
    expect(historyFor([user("a", "2026-03-01T00:00:00.000Z"), request("expired", "2026-03-02T00:00:01.000Z"), user("b", "2026-03-03T00:00:00.000Z")])).toEqual([
      { role: "user", content: expect.stringMatching(/^a\n\n\[Hearth: the request to delete 1 entry from "Ledger" .* expired .*nothing was deleted\.\]\n\nb$/) },
    ]);
    const partly = { ...request("confirmed", "2026-03-01T00:01:00.000Z"), count: 3, deleted: 2 };
    expect(historyFor([user("a", "2026-03-01T00:00:00.000Z"), partly, user("b", "2026-03-01T00:02:00.000Z")]).at(-1)!.content).toMatch(
      /confirmed deleting 3 entries .*; 2 deleted, the others were gone already/,
    );
  });
});

describe("a row's preview", () => {
  const row = (fields: Record<string, unknown>) => ({ id: "row-1", createdBy: "u", updatedBy: "u", createdAt: "", updatedAt: "", ...fields });

  it("joins the first fields that hold something, in the manifest's order", () => {
    expect(previewOf(row({ done: true, name: "Milk", amount: 2, tags: ["a", "b"], note: "x" }), ["done", "name", "amount", "tags", "note"])).toBe("Milk · 2 · a, b");
    expect(previewOf(row({ name: "  Two\nlines " }), ["name"])).toBe("Two lines");
  });

  it("is cut at 80 characters, never inside one, and is the row's ID when nothing else says anything", () => {
    const cut = previewOf(row({ name: "😀".repeat(100) }), ["name"]);
    expect(Array.from(cut)).toHaveLength(81);
    expect(cut.endsWith("😀…")).toBe(true);
    expect(previewOf(row({ done: false }), ["done"])).toBe("row-1");
  });

  it("shows at most five rows of a request", async () => {
    let rowIds: string[] = [];
    const w = await world([() => askToDelete({ appId: OURS, collection: "items", rowIds })(), say("Confirm?")]);
    for (let n = 0; n < 4; n++) {
      const response = await w.call(SAM, "POST", `/api/spaces/${w.family}/apps/${OURS}/rows/items`, { data: { name: `Item ${n}` } });
      rowIds.push(((await response.json()) as { row: { id: string } }).row.id);
    }
    rowIds = [w.rows.milk, w.rows.bread, w.rows.eggs, ...rowIds];
    const events = await w.chat(SAM, "Delete everything");
    expect(events.find((event) => event.action === "delete_requested")).toMatchObject({
      count: 7,
      preview: ["Milk · Dairy", "Bread", "Eggs", "Item 0", "Item 1"],
    });
  });
});

describe("deleting a whole app", () => {
  const del = (w: Awaited<ReturnType<typeof world>>, email: string, body: unknown, appId = OURS) =>
    w.call(email, "DELETE", `/api/spaces/${w.family}/apps/${appId}/data`, body);

  it("is for the space's owners, never a member, even one who may edit it or add apps", async () => {
    const w = await world();
    w.db.prepare("UPDATE app_access SET level = 'edit' WHERE user_id = ?").run(w.kim.id);
    for (const email of [LIN, KIM]) {
      const response = await del(w, email, { confirm: "Checklist" });
      expect(response.status, email).toBe(403);
    }
    expect((await del(w, NOA, { confirm: "Checklist" })).status).toBe(404);
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
  });

  it("needs the app's name, and a wrong one deletes nothing", async () => {
    const w = await world();
    for (const confirm of ["Checklis", "Journal", OURS, ""]) {
      expect((await del(w, SAM, { confirm })).status, confirm).toBe(400);
    }
    expect(w.items()).toEqual(["Milk", "Bread", "Eggs"]);
    expect(countOf(w.db, "space_apps", w.family, OURS)).toBe(1);
  });

  it("leaves no row of the app in any table, takes waiting requests to expired, and leaves other apps alone", async () => {
    let rowIds: string[] = [];
    const w = await world([() => askToDelete({ appId: OURS, collection: "items", rowIds })(), say("Confirm?")]);
    rowIds = [w.rows.milk];
    const events = await w.chat(LIN, "Delete milk");
    // Everything an app can have: settings of the space and of a person, an exception, a switch, a new version.
    w.db.prepare("INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at) VALUES (?, ?, NULL, '{}', ?, ?, ?)").run(w.family, OURS, w.sam.id, w.sam.id, "2026-01-07T00:00:00.000Z");
    w.db.prepare("INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at) VALUES (?, ?, ?, '{}', ?, ?, ?)").run(w.family, OURS, w.lin.id, w.lin.id, w.lin.id, "2026-01-07T00:00:00.000Z");
    w.db.prepare("INSERT INTO app_prefs (space_id, app_id, user_id, pinned) VALUES (?, ?, ?, 1)").run(w.family, OURS, w.lin.id);
    w.db.prepare("INSERT INTO made_app_versions (app_id, version, manifest, html, note, created_by, created_at) SELECT app_id, 2, manifest, html, 'v2', created_by, created_at FROM made_apps WHERE app_id = ?").run(OURS);
    const tablesWithApp = (w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((table) => table.name)
      .filter((table) => (w.db.pragma(`table_info(${table})`) as { name: string }[]).some((column) => column.name === "app_id"));
    const holding = (appId: string) =>
      Object.fromEntries(
        tablesWithApp.map((table) => [table, (w.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE app_id = ?`).get(appId) as { n: number }).n]),
      );
    const diaryBefore = holding(DIARY);
    const ownBefore = holding(OWN);
    expect(holding(OURS)).toMatchObject({ space_apps: 1, app_rows: 3, app_settings: 2, app_access: 1, app_prefs: 1, made_apps: 1, made_app_versions: 2, chat_confirmations: 1 });

    expect((await del(w, SAM, { confirm: " 清单 " })).status).toBe(204);
    // What is left is the conversation's own record of the request, which can no longer be carried out.
    const left = holding(OURS);
    expect(Object.entries(left).filter(([table, n]) => table !== "chat_confirmations" && n > 0)).toEqual([]);
    expect(w.db.prepare("SELECT status FROM chat_confirmations WHERE app_id = ?").all(OURS)).toEqual([{ status: "expired" }]);
    expect(await w.requestEntry(LIN, events.chatId)).toMatchObject({ status: "expired" });
    expect(holding(DIARY)).toEqual(diaryBefore);
    expect(holding(OWN)).toEqual(ownBefore);
    // Nobody sees it any more; the journal stays for everyone.
    for (const email of [SAM, LIN, KIM]) {
      const session = (await (await w.call(email, "GET", "/api/session")).json()) as { apps: { id: string }[] };
      expect(session.apps.map((app) => app.id), email).not.toContain(OURS);
    }
    expect(w.errors).toEqual([]);
  });

  it("works for a removed app, which the owners' list names, draws and counts", async () => {
    const w = await world();
    expect((await w.call(SAM, "DELETE", `/api/spaces/${w.family}/apps/${OURS}`)).status).toBe(204);
    const list = (await (await w.call(SAM, "GET", `/api/spaces/${w.family}/apps`)).json()) as { apps: Record<string, unknown>[] };
    expect(list.apps.find((app) => app.id === OURS)).toMatchObject({
      removedAt: expect.any(String),
      rowCount: 3,
      name: { en: "Checklist", zh: "清单" },
      icon: CHECKLIST.icon,
      color: CHECKLIST.color,
    });
    expect((await del(w, SAM, { confirm: "Checklist" })).status).toBe(204);
    expect(countOf(w.db, "space_apps", w.family, OURS)).toBe(0);
    // And bringing back a removed app is the route that restores an install.
    expect((await w.call(SAM, "DELETE", `/api/spaces/${w.family}/apps/${DIARY}`)).status).toBe(204);
    expect((await w.call(SAM, "PUT", `/api/spaces/${w.family}/apps/${DIARY}`, {})).status).toBe(204);
    expect(countOf(w.db, "app_rows", w.family, DIARY)).toBe(1);
  });
});
