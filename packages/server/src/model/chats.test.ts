/**
 * The chat's history (docs/platform.md, "The chat"). The risks: one person
 * reading or deleting another's conversation, in the same group too; a
 * conversation of one space reached through another; rows left behind when
 * someone leaves a group; entries kept out of order; the history the model
 * is given going over its budget or not alternating; the limits; two runs
 * of one conversation at once; and a conversation deleted while it answers.
 * Nothing here reaches a real model.
 */
import type { ChatEntry } from "@hearth/shared";
import { describe, expect, it } from "vitest";
import { family, KIM, LIN, SAM } from "../apps/test-world";
import { as, testApp, testConfig } from "../testing";
import { HISTORY_BUDGET, MAX_CHATS, MAX_ENTRIES, appendEntry, createChat, historyFor, listChats, readChat, titleOf } from "./chats";

const SECRET = "a-secret-for-tests-only-32-chars!!";
const AT = "2026-03-01T00:00:00.000Z";

type Event = { type: string; [key: string]: unknown };

function world(modelFetch?: typeof fetch) {
  const people = family();
  const { app, db, errors } = testApp({ db: people.db, config: testConfig({ secret: SECRET }), ...(modelFetch ? { modelFetch } : {}) });
  const call = (email: string, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: as(email, init.body ? { "Content-Type": "application/json" } : {}) });
  const post = (email: string, body: Record<string, unknown>) => call(email, "/api/chat", { method: "POST", body: JSON.stringify(body) });
  const eventsOf = async (response: Response) =>
    (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Event);
  /** Says something in a new conversation and gives its ID. With the assistant off, the turn ends with a failure and no model is asked. */
  const start = async (email: string, spaceId: string, message = "Plan the week") => {
    const events = await eventsOf(await post(email, { spaceId, message }));
    expect(events[0]).toMatchObject({ type: "chat", chatId: expect.any(String) });
    return events[0]!.chatId as string;
  };
  const list = async (email: string, spaceId: string) =>
    ((await (await call(email, `/api/spaces/${spaceId}/chats`)).json()) as { chats: { id: string; title: string }[] }).chats;
  const count = (table: string, where = "1 = 1", ...params: unknown[]) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
  const saveModel = (email: string) =>
    call(email, "/api/me/model", {
      method: "PUT",
      body: JSON.stringify({ protocol: "openai", baseUrl: "https://api.example.com/v1", model: "chat-1", apiKey: "sk-test" }),
    });
  return { ...people, app, db, errors, call, post, eventsOf, start, list, count, saveModel };
}

const answer = (content: string) =>
  Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });

describe("a person's conversations", () => {
  it("are listed for them alone, in the space they were had in, the one used last first", async () => {
    const { samsSpace, family: group, start, list, post, eventsOf } = world();
    const first = await start(SAM, group, "  Plan   the\nweek  ");
    const second = await start(SAM, group, "Groceries");
    const elsewhere = await start(SAM, samsSpace, "Just mine");
    const lins = await start(LIN, group, "我的计划");

    expect(await list(SAM, group)).toEqual([
      { id: second, title: "Groceries", createdAt: expect.any(String), updatedAt: expect.any(String) },
      { id: first, title: "Plan the week", createdAt: expect.any(String), updatedAt: expect.any(String) },
    ]);
    expect((await list(SAM, samsSpace)).map((chat) => chat.id)).toEqual([elsewhere]);
    expect((await list(LIN, group)).map((chat) => chat.id)).toEqual([lins]);
    expect(await list(KIM, group)).toEqual([]);

    // Saying something again brings it to the top.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await eventsOf(await post(SAM, { spaceId: group, chatId: first, message: "And the weekend" }));
    expect((await list(SAM, group)).map((chat) => chat.id)).toEqual([first, second]);
  });

  it("cannot be read, answered or deleted by anyone else, in the same group too", async () => {
    const { family: group, noa, start, call, post, count } = world();
    const sams = await start(SAM, group);
    for (const email of [LIN, KIM]) {
      expect((await call(email, `/api/spaces/${group}/chats/${sams}`)).status, email).toBe(404);
      expect((await call(email, `/api/spaces/${group}/chats/${sams}`, { method: "DELETE" })).status, email).toBe(404);
      expect((await post(email, { spaceId: group, chatId: sams, message: "Hello" })).status, email).toBe(404);
    }
    // Someone outside the group gets the answer of a space that is not there.
    expect((await call("noa@example.com", `/api/spaces/${group}/chats`)).status).toBe(404);
    expect((await call("noa@example.com", `/api/spaces/${group}/chats/${sams}`)).status).toBe(404);
    expect(noa.id).toBeTruthy();
    // Nothing of it changed.
    expect(count("chat_entries", "chat_id = ?", sams)).toBe(2);
    expect((await call(SAM, `/api/spaces/${group}/chats/${sams}`)).status).toBe(200);
  });

  it("cannot be reached through another space, even one the person is in", async () => {
    const { samsSpace, family: group, start, call, post, count } = world();
    const inGroup = await start(SAM, group);
    expect((await call(SAM, `/api/spaces/${samsSpace}/chats/${inGroup}`)).status).toBe(404);
    expect((await call(SAM, `/api/spaces/${samsSpace}/chats/${inGroup}`, { method: "DELETE" })).status).toBe(404);
    // A message for it sent to the other space is not kept in it, nor anywhere.
    expect((await post(SAM, { spaceId: samsSpace, chatId: inGroup, message: "Hello" })).status).toBe(404);
    expect(count("chat_entries")).toBe(2);
    expect(count("chats")).toBe(1);
  });

  it("are deleted by their person alone, with their entries, and then are gone", async () => {
    const { family: group, start, call, post, list, count } = world();
    const first = await start(SAM, group);
    const second = await start(SAM, group);
    expect((await call(SAM, `/api/spaces/${group}/chats/${first}`, { method: "DELETE" })).status).toBe(204);
    expect((await list(SAM, group)).map((chat) => chat.id)).toEqual([second]);
    expect(count("chat_entries", "chat_id = ?", first)).toBe(0);
    expect((await call(SAM, `/api/spaces/${group}/chats/${first}`)).status).toBe(404);
    expect((await call(SAM, `/api/spaces/${group}/chats/${first}`, { method: "DELETE" })).status).toBe(404);
    expect((await post(SAM, { spaceId: group, chatId: first, message: "Hello" })).status).toBe(404);
  });

  it("go when their person leaves the group or is removed from it, and only theirs", async () => {
    const { family: group, lin, kim, linsSpace, start, call, count } = world();
    await start(SAM, group);
    await start(LIN, group);
    await start(LIN, linsSpace);
    await start(KIM, group);

    expect((await call(LIN, `/api/spaces/${group}/members/${lin.id}`, { method: "DELETE" })).status).toBe(204);
    expect(count("chats", "user_id = ? AND space_id = ?", lin.id, group)).toBe(0);
    expect(count("chat_entries", "user_id = ? AND space_id = ?", lin.id, group)).toBe(0);
    expect(count("chats", "user_id = ? AND space_id = ?", lin.id, linsSpace)).toBe(1);

    expect((await call(SAM, `/api/spaces/${group}/members/${kim.id}`, { method: "DELETE" })).status).toBe(204);
    expect(count("chats", "user_id = ?", kim.id)).toBe(0);
    expect(count("chat_entries", "user_id = ?", kim.id)).toBe(0);
    expect(count("chats", "space_id = ?", group)).toBe(1);
  });

  it("keep the person's message first, and whatever ended the turn after it", async () => {
    const { family: group, start, call } = world();
    const chatId = await start(SAM, group, "Plan the week");
    expect(await (await call(SAM, `/api/spaces/${group}/chats/${chatId}`)).json()).toEqual({
      chat: { id: chatId, title: "Plan the week", createdAt: expect.any(String), updatedAt: expect.any(String) },
      entries: [
        { kind: "user", text: "Plan the week" },
        { kind: "failure", failure: "assistant_off", detail: expect.any(String) },
      ],
    });
  });
});

describe("the limits", () => {
  it("refuse a new conversation once the person keeps 500 in the space, and no one else's", async () => {
    const { db, sam, family: group, samsSpace, post, start } = world();
    const insert = db.prepare("INSERT INTO chats (id, space_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, 'Sample', ?, ?)");
    db.transaction(() => {
      for (let n = 0; n < MAX_CHATS; n++) insert.run(`chat-${n}`, group, sam.id, AT, AT);
    })();
    const refused = await post(SAM, { spaceId: group, message: "One more" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: "conflict", message: "You have 500 conversations here. Delete some to start a new one." },
    });
    expect(() => createChat(db, { spaceId: group, userId: sam.id, title: "x", now: AT })).toThrow(/500 conversations/);
    // Lin is not held back by Sam's, nor Sam in another space.
    await start(LIN, group);
    await start(SAM, samsSpace);
  });

  it("refuse a message in a conversation that holds 500 entries", async () => {
    const { db, sam, family: group, start, post } = world();
    const chatId = await start(SAM, group);
    db.transaction(() => {
      for (let n = 2; n < MAX_ENTRIES; n++) {
        appendEntry(db, { spaceId: group, userId: sam.id, chatId, entry: { kind: "user", text: `${n}` }, now: AT });
      }
    })();
    const refused = await post(SAM, { spaceId: group, chatId, message: "One more" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "conflict", message: "This conversation is full. Start a new one." } });
    expect(readChat(db, { spaceId: group, userId: sam.id, chatId })!.entries).toHaveLength(MAX_ENTRIES);
  });
});

describe("one run per conversation", () => {
  it("refuses a second message while the first is answering, and takes one once it has answered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    const model = (async () => {
      asked++;
      if (asked === 2) await gate;
      return answer(`Answer ${asked}`);
    }) as unknown as typeof fetch;
    const { samsSpace, db, sam, saveModel, start, post, eventsOf, errors } = world(model);
    await saveModel(SAM);
    db.prepare("UPDATE spaces SET assistant = 'edit' WHERE id = ?").run(samsSpace);
    const chatId = await start(SAM, samsSpace);

    const answering = await post(SAM, { spaceId: samsSpace, chatId, message: "Second" });
    expect(answering.status).toBe(200);
    const busy = await post(SAM, { spaceId: samsSpace, chatId, message: "From another tab" });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({
      error: { code: "conflict", message: "This conversation is still answering, in another window or tab." },
    });
    // Another conversation of the same person answers meanwhile.
    expect((await post(SAM, { spaceId: samsSpace, message: "Elsewhere" })).status).toBe(200);

    release();
    expect((await eventsOf(answering)).at(-1)).toEqual({ type: "done" });
    const after = await eventsOf(await post(SAM, { spaceId: samsSpace, chatId, message: "Third" }));
    expect(after.at(-1)).toEqual({ type: "done" });
    expect(readChat(db, { spaceId: samsSpace, userId: sam.id, chatId })!.entries.filter((entry) => entry.kind === "user")).toEqual([
      { kind: "user", text: "Plan the week" },
      { kind: "user", text: "Second" },
      { kind: "user", text: "Third" },
    ]);
    expect(errors).toEqual([]);
  });

  it("stops a run whose conversation is deleted while it answers, and keeps nothing more", async () => {
    const its: { world?: ReturnType<typeof world>; chatId?: string } = {};
    const asked: unknown[] = [];
    const model = (async (_input: unknown, init?: RequestInit) => {
      asked.push(init?.body);
      // The person deletes it in another tab while the model is thinking.
      expect((await its.world!.call(SAM, `/api/spaces/${its.world!.samsSpace}/chats/${its.chatId}`, { method: "DELETE" })).status).toBe(204);
      // Text and a tool call: without the stop, the tool would run and the model be asked again.
      const call = { id: "call_1", type: "function", function: { name: "list_rows", arguments: JSON.stringify({ appId: "app-1", collection: "items" }) } };
      return Response.json({
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Adding it.", tool_calls: [call] } }],
      });
    }) as unknown as typeof fetch;
    its.world = world(model);
    const { samsSpace, db, saveModel, start, post, eventsOf, count, errors } = its.world;
    await saveModel(SAM);
    const chatId = await start(SAM, samsSpace);
    its.chatId = chatId;
    db.prepare("UPDATE spaces SET assistant = 'edit' WHERE id = ?").run(samsSpace);

    const events = await eventsOf(await post(SAM, { spaceId: samsSpace, chatId, message: "Add milk" }));
    // The model's text would have been the next entry: neither kept nor sent, and the run asked no more.
    expect(events).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(count("chats")).toBe(0);
    expect(count("chat_entries")).toBe(0);
    expect(errors).toEqual([]);
    // The conversation is free again, and gone.
    expect((await post(SAM, { spaceId: samsSpace, chatId, message: "Again" })).status).toBe(404);
  });

  it("keeps nothing a stop prevented: no further change of the step, and no further step", async () => {
    let asked = 0;
    const make = (id: string, name: string) => ({
      id,
      type: "function",
      function: {
        name: "create_app",
        arguments: JSON.stringify({ manifest: { name, icon: "wallet", collections: { items: { fields: { item: { type: "text" } } } } }, html: "<p>x</p>" }),
      },
    });
    const model = (async (_input: unknown, init?: RequestInit) => {
      // As a real fetch does, a stopped request is not sent.
      init?.signal?.throwIfAborted();
      asked++;
      return Response.json({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: { role: "assistant", content: "Making three.", tool_calls: [make("call_1", "One"), make("call_2", "Two"), make("call_3", "Three")] },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const { samsSpace, db, sam, saveModel, post, count, errors } = world(model);
    await saveModel(SAM);
    db.prepare("UPDATE spaces SET assistant = 'edit' WHERE id = ?").run(samsSpace);

    // The person presses Stop once the first app shows.
    const response = await post(SAM, { spaceId: samsSpace, message: "Make apps" });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"type":"action"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    const chatId = /"chatId":"([^"]+)"/.exec(seen)![1]!;
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readChat(db, { spaceId: samsSpace, userId: sam.id, chatId })!.entries).toEqual([
      { kind: "user", text: "Make apps" },
      { kind: "model", text: "Making three." },
      { kind: "action", action: "app_created", appId: expect.any(String), appName: "One" },
    ]);
    expect(count("made_apps", "space_id = ?", samsSpace)).toBe(1);
    expect(asked).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe("historyFor", () => {
  const user = (text: string): ChatEntry => ({ kind: "user", text });
  const model = (text: string): ChatEntry => ({ kind: "model", text });

  it("gives what was said as plain text, without changes or failures, the steps of one side joined", () => {
    expect(
      historyFor([
        user("Make a list"),
        model("Making it."),
        { kind: "action", action: "app_created", appId: "app-1", appName: "List" },
        model("Done."),
        user("Add milk"),
        { kind: "failure", failure: "model_failed", detail: "Cut off." },
        user("Again?"),
      ]),
    ).toEqual([
      { role: "user", content: "Make a list" },
      { role: "assistant", content: "Making it.\n\nDone." },
      { role: "user", content: "Add milk\n\nAgain?" },
    ]);
  });

  it("keeps the newest within the budget, starting with something the person said", () => {
    const long = "x".repeat(15_000);
    const history = historyFor([user("o".repeat(1_000)), model("m".repeat(9_000)), user(long), model(long), user("new")]);
    // The newest that fit start with the model's 9000 characters, which go, since the person speaks first.
    expect(history).toEqual([
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: "new" },
    ]);
    expect(history.reduce((size, message) => size + message.content.length, 0)).toBeLessThanOrEqual(HISTORY_BUDGET);
  });

  it("always holds the new message, even after a text that alone is over the budget", () => {
    expect(historyFor([user("old"), model("y".repeat(HISTORY_BUDGET + 1)), user("new")])).toEqual([{ role: "user", content: "new" }]);
    expect(historyFor([user("z".repeat(20_000)), user("z".repeat(20_000)), user("new")])).toEqual([
      { role: "user", content: `${"z".repeat(20_000)}\n\nnew` },
    ]);
  });
});

describe("titleOf", () => {
  it("is the first message on one line, cut at 80 characters with an ellipsis", () => {
    expect(titleOf("  Plan\n\tthe   week ")).toBe("Plan the week");
    expect(titleOf("a".repeat(80))).toBe("a".repeat(80));
    expect(titleOf("a".repeat(81))).toBe(`${"a".repeat(80)}…`);
    // A character outside the basic plane is never cut in two.
    expect(titleOf("😀".repeat(81))).toBe(`${"😀".repeat(80)}…`);
  });
});

describe("the SQL", () => {
  const user = (text: string): ChatEntry => ({ kind: "user", text });

  it("never lists, reads or adds to another person's conversation, whatever it is asked", () => {
    const { db, sam, lin, family: group } = world();
    const sams = createChat(db, { spaceId: group, userId: sam.id, title: "Sam's", now: AT });
    expect(listChats(db, { spaceId: group, userId: lin.id })).toEqual([]);
    expect(readChat(db, { spaceId: group, userId: lin.id, chatId: sams.id })).toBeNull();
    expect(appendEntry(db, { spaceId: group, userId: lin.id, chatId: sams.id, entry: user("x"), now: AT })).toBe(false);
    expect(readChat(db, { spaceId: group, userId: sam.id, chatId: sams.id })!.entries).toEqual([]);
  });

  it("refuses a conversation for someone who is not in the space", () => {
    const { db, noa, family: group } = world();
    expect(() => createChat(db, { spaceId: group, userId: noa.id, title: "x", now: AT })).toThrow(/FOREIGN KEY/);
  });

  it("keeps entries in the order they were added", () => {
    const { db, sam, samsSpace } = world();
    const chat = createChat(db, { spaceId: samsSpace, userId: sam.id, title: "x", now: AT });
    const texts = Array.from({ length: 12 }, (_, n) => `${n}`);
    for (const text of texts) appendEntry(db, { spaceId: samsSpace, userId: sam.id, chatId: chat.id, entry: user(text), now: AT });
    expect(readChat(db, { spaceId: samsSpace, userId: sam.id, chatId: chat.id })!.entries.map((entry) => (entry as { text: string }).text)).toEqual(texts);
  });
});
