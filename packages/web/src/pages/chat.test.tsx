/**
 * The chat page and the conversations the server keeps (docs/platform.md,
 * "The chat"): the list of the person's own conversations in a space,
 * opening one, a new one getting its ID, changing the space, deleting, and
 * what the page says when the server turns a message down. The whole web
 * app is drawn against a stand-in for the server.
 */
import type { AppSummary, ChatEntry, ChatEvent, ChatSummary, ConfirmationResult, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

/** The apps whose pages on screen were told to read their rows again, in order. */
const notified = vi.hoisted(() => [] as string[]);
vi.mock("../made/frame", async (importOriginal) => {
  const real = await importOriginal<typeof import("../made/frame")>();
  return {
    ...real,
    notifyMadeAppChanged: (appId: string, source: Window | null = null) => {
      notified.push(appId);
      real.notifyMadeAppChanged(appId, source);
    },
  };
});

const PERSONAL = "space-personal";
const FAMILY = "space-family";

const NOTES: AppSummary = {
  id: "m-notes",
  spaceId: PERSONAL,
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Notes, made in Hearth.", zh: "笔记，在 Hearth 里做的。" },
  icon: "list-checks",
  color: "teal",
  widgetSize: "wide",
  access: "edit",
  enabled: true,
  pinned: false,
  hasPage: true,
  made: true,
  version: 2,
};

const summary = (id: string, title: string, updatedAt: string): ChatSummary => ({ id, title, createdAt: updatedAt, updatedAt });

type Refusal = { status: number; message: string };

class FakeServer {
  locale: "en" | "zh" = "en";
  chats: Record<string, ChatSummary[]> = {
    [PERSONAL]: [summary("c-recent", "Plan the week", "2026-11-20T09:00:00.000Z"), summary("c-older", "Groceries", "2026-11-01T09:00:00.000Z")],
    [FAMILY]: [summary("c-family", "Holiday list", "2026-11-10T09:00:00.000Z")],
  };
  entries: Record<string, ChatEntry[]> = {
    "c-recent": [
      { kind: "user", text: "Keep notes for me" },
      { kind: "model", text: "I changed Notes for you." },
      { kind: "action", action: "app_updated", appId: "m-notes", appName: "Notes", version: 2, previous: 1 },
      { kind: "failure", failure: "too_many_steps", detail: "" },
    ],
    "c-older": [{ kind: "user", text: "Groceries please" }],
    "c-family": [{ kind: "user", text: "Holiday list" }],
  };
  /** What POST /api/chat answers: a refusal before the stream, or these events. */
  refuse: Refusal | null = null;
  events: ChatEvent[] = [
    { type: "chat", chatId: "c-new", title: "Hello there" },
    { type: "text", text: "Noted: Hello there" },
    { type: "done" },
  ];
  /** Keeps the stream open after the events, as a model still answering does, until the page stops reading. */
  hang = false;
  /** Whether the page stopped the last stream. */
  stopped = false;
  /** Holds POST /api/chat's answer back until it settles, as a slow network does. */
  gate: Promise<void> | null = null;
  /** Keeps the stream open after the events until this settles, as a model that takes its time to finish does. */
  finish: Promise<void> | null = null;
  requests: string[] = [];
  bodies: unknown[] = [];
  apps: AppSummary[] = [NOTES];
  /**
   * Requests of the model's to delete, by ID: where each stands, which the
   * conversation is given with, and what answering it does now (`refuse`,
   * or else the answer it gets).
   */
  confirmations: Record<string, ConfirmationResult & { refuse?: { status: number; code: string } }> = {};
  /** Holds the answer to a request to delete back until it settles. */
  answerGate: Promise<void> | null = null;
  /** Whether the person has saved a model with its key, and how far the assistant may go in their own space. */
  hasKey = true;
  personalAssistant: "none" | "edit" = "edit";

  session(): Session {
    const me = { id: "u1", name: "Sam Example", role: "owner" as const };
    return {
      user: { id: "u1", email: "sam@example.com", name: "Sam Example", locale: this.locale, theme: "light" },
      spaces: [
        { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, members: [me], assistant: this.personalAssistant },
        { id: FAMILY, kind: "group", name: "Family", role: "owner", canAddApps: true, members: [me], assistant: "edit" },
      ],
      apps: this.apps,
      canCreateGroups: false,
      canInvitePeople: false,
      version: "test",
    };
  }

  answer(path: string, init: RequestInit): Response {
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const refused = (status: number, message: string) =>
      json({ error: { code: status === 404 ? "not_found" : "conflict", message } }, status);
    if (path === "/api/session") return json(this.session());
    if (path === "/api/me/model") return json({ protocol: "openai", baseUrl: "https://api.example.com/v1", model: "sample", hasKey: this.hasKey });
    const assistant = /^\/api\/spaces\/([^/]+)\/assistant$/.exec(path);
    if (assistant && method === "PUT") {
      const { level } = JSON.parse(String(init.body)) as { level: "none" | "edit" };
      if (decodeURIComponent(assistant[1]!) === PERSONAL) this.personalAssistant = level;
      return new Response(null, { status: 204 });
    }
    const answer = /^\/api\/spaces\/([^/]+)\/chats\/([^/]+)\/confirmations\/([^/]+)$/.exec(path);
    if (answer && method === "POST") {
      this.bodies.push(JSON.parse(String(init.body)));
      const asked = this.confirmations[decodeURIComponent(answer[3]!)];
      if (!asked) return json({ error: { code: "not_found", message: "Not found." } }, 404);
      if (asked.refuse) return json({ error: { code: asked.refuse.code, message: "Sample refusal." } }, asked.refuse.status);
      if (asked.status !== "pending") return json({ error: { code: "conflict", message: "Answered already." } }, 409);
      const { decision } = JSON.parse(String(init.body)) as { decision: "confirm" | "decline" };
      const result: ConfirmationResult = decision === "confirm" ? { status: "confirmed", deleted: asked.deleted } : { status: "declined", deleted: 0 };
      this.confirmations[decodeURIComponent(answer[3]!)] = result;
      return json(result);
    }
    const list = /^\/api\/spaces\/([^/]+)\/chats$/.exec(path);
    if (list) return json({ chats: this.chats[decodeURIComponent(list[1]!)] ?? [] });
    const one = /^\/api\/spaces\/([^/]+)\/chats\/([^/]+)$/.exec(path);
    if (one) {
      const spaceId = decodeURIComponent(one[1]!);
      const chat = (this.chats[spaceId] ?? []).find((candidate) => candidate.id === decodeURIComponent(one[2]!));
      if (!chat) return refused(404, "Not found.");
      if (method === "DELETE") {
        this.chats[spaceId] = this.chats[spaceId]!.filter((candidate) => candidate !== chat);
        return new Response(null, { status: 204 });
      }
      // Where each request to delete stands is read afresh, as the server does.
      const entries = (this.entries[chat.id] ?? []).map((entry) => {
        const now = entry.kind === "action" && entry.confirmationId ? this.confirmations[entry.confirmationId] : undefined;
        return now ? { ...entry, status: now.status, deleted: now.deleted } : entry;
      });
      return json({ chat, entries });
    }
    if (path === "/api/chat" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { spaceId: string; chatId?: string; message: string };
      this.bodies.push(body);
      if (this.refuse) return refused(this.refuse.status, this.refuse.message);
      const started = this.events.find((event) => event.type === "chat");
      if (started?.type === "chat") this.chats[body.spaceId]!.unshift(summary(started.chatId, started.title, "2026-11-23T09:00:00.000Z"));
      const text = this.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const hang = this.hang;
      const finish = this.finish;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(text));
          if (finish) {
            void finish.then(() => controller.close());
            return;
          }
          if (!hang) return controller.close();
          // A fetch that is stopped ends its body with an AbortError, as a browser's does.
          const stop = () => {
            this.stopped = true;
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (init.signal?.aborted) return stop();
          init.signal?.addEventListener("abort", stop);
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return refused(404, "No such route.");
  }
}

/** Where the page's address is now, and the browser's Back. */
let where = "";
let back = () => {};
function Address() {
  const location = useLocation();
  const navigate = useNavigate();
  where = location.pathname + location.search;
  back = () => void navigate(-1);
  return null;
}

/** Draws the app at `at`, or at the last of several addresses, the ones before it in the history. */
function start(server: FakeServer, at: string | string[] = "/chat") {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (server.gate && String(input) === "/api/chat") await server.gate;
    if (server.answerGate && String(input).includes("/confirmations/")) await server.answerGate;
    return server.answer(String(input), init);
  });
  const entries = Array.isArray(at) ? at : [at];
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />
      <Address />
    </MemoryRouter>,
  );
}

const conversations = () => screen.getByRole("navigation", { name: "Conversations" });
/** The list, once the session is read and the page drawn. */
const listed = () => screen.findByRole("navigation", { name: "Conversations" });
const box = () => screen.getByRole("textbox", { name: "Message your model" });
const send = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};
const searchOf = () => Object.fromEntries(new URL(where, "http://localhost").searchParams);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  notified.length = 0;
});

describe("the list of conversations", () => {
  it("lists the person's conversations in the space, the one used last first, each with when it was used", async () => {
    const server = new FakeServer();
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    const links = within(conversations()).getAllByRole("link");
    expect(links.map((link) => link.querySelector(".clip")?.textContent)).toEqual(["Plan the week", "Groceries"]);
    expect(links[0]!.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-20T09:00:00.000Z");
    expect(links[0]!.getAttribute("href")).toBe(`/chat?space=${PERSONAL}&chat=c-recent`);
    // /chat alone is the personal space and a new conversation: nothing is open.
    expect(links.every((link) => link.getAttribute("aria-current") === null)).toBe(true);
    expect(server.requests).toContain(`GET /api/spaces/${PERSONAL}/chats`);
    expect(within(conversations()).getByRole("button", { name: "Delete conversation Groceries" })).toBeTruthy();
  });

  it("says so when there is none yet", async () => {
    const server = new FakeServer();
    server.chats[PERSONAL] = [];
    start(server);
    expect(await within(await listed()).findByText("No conversations here yet.")).toBeTruthy();
  });
});

describe("opening a conversation", () => {
  it("draws what was kept, with the Undo of a change, and keeps it open in the address", async () => {
    const server = new FakeServer();
    start(server);
    fireEvent.click(await within(await listed()).findByRole("link", { name: /Plan the week/ }));

    expect(await screen.findByText("I changed Notes for you.")).toBeTruthy();
    expect(screen.getByText("Keep notes for me")).toBeTruthy();
    expect(screen.getByText(/Changed the app “Notes” \(version 2\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getByText("Your model took too many steps and was stopped.")).toBeTruthy();
    expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-recent" });
    expect(server.requests).toContain(`GET /api/spaces/${PERSONAL}/chats/c-recent`);
    expect(within(conversations()).getByRole("link", { name: /Plan the week/ }).getAttribute("aria-current")).toBe("page");
  });

  it("offers no Undo of a change once the app has changed again since", async () => {
    const server = new FakeServer();
    server.apps = [{ ...NOTES, version: 4 }];
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText(/Changed the app “Notes” \(version 2\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("opens the conversation the address names, as after a reload, and sends what follows to it", async () => {
    const server = new FakeServer();
    server.events = [{ type: "text", text: "Noted: more" }, { type: "done" }];
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();

    send("more");
    expect(await screen.findByText("Noted: more")).toBeTruthy();
    expect(server.bodies).toEqual([{ spaceId: PERSONAL, chatId: "c-older", message: "more" }]);
    expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-older" });
  });

  it("keeps what was said before out of the live region, so opening it does not read it all aloud", async () => {
    const server = new FakeServer();
    server.events = [{ type: "text", text: "Noted: Hello there" }, { type: "done" }];
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect((await screen.findByText("Keep notes for me")).closest("[aria-live]")).toBeNull();
    send("Hello there");
    const answer = await screen.findByText("Noted: Hello there");
    expect(answer.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Hello there", { selector: "div" }).closest("[aria-live]")).not.toBeNull();
    expect(screen.getByText("Keep notes for me").closest("[aria-live]")).toBeNull();
  });

  it("reads a conversation afresh each time it is opened", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("link", { name: /Groceries/ }));
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    expect(screen.queryByText("Keep notes for me")).toBeNull();

    server.entries["c-recent"]!.push({ kind: "model", text: "Said in another tab." });
    fireEvent.click(within(conversations()).getByRole("link", { name: /Plan the week/ }));
    expect(await screen.findByText("Said in another tab.")).toBeTruthy();

    // Also after a new conversation was open in between.
    server.entries["c-recent"]!.push({ kind: "model", text: "And in another." });
    fireEvent.click(within(conversations()).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(screen.queryByText("Keep notes for me")).toBeNull());
    fireEvent.click(within(conversations()).getByRole("link", { name: /Plan the week/ }));
    expect(await screen.findByText("And in another.")).toBeTruthy();
    expect(server.requests.filter((request) => request === `GET /api/spaces/${PERSONAL}/chats/c-recent`)).toHaveLength(3);
  });

  it("starts a new one when the conversation is gone", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-deleted`);
    expect(await screen.findByText("This conversation is gone.")).toBeTruthy();
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
  });
});

describe("a new conversation", () => {
  it("gets its ID into the address, in place of the new one, and into the list", async () => {
    const server = new FakeServer();
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    const reads = () => server.requests.filter((request) => request === `GET /api/spaces/${PERSONAL}/chats`).length;
    const before = reads();

    send("Hello there");
    expect(await screen.findByText("Noted: Hello there")).toBeTruthy();
    expect(screen.getByText("Hello there", { selector: "div" })).toBeTruthy();
    expect(server.bodies).toEqual([{ spaceId: PERSONAL, message: "Hello there" }]);
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-new" }));
    expect(await within(conversations()).findByRole("link", { name: /Hello there/ })).toBeTruthy();
    expect(reads()).toBeGreaterThan(before);
    // It was not read back: the page drew what the turn sent.
    expect(server.requests).not.toContain(`GET /api/spaces/${PERSONAL}/chats/c-new`);

    // The next message goes to it.
    server.events = [{ type: "text", text: "Noted: again" }, { type: "done" }];
    send("again");
    expect(await screen.findByText("Noted: again")).toBeTruthy();
    expect(server.bodies[1]).toEqual({ spaceId: PERSONAL, chatId: "c-new", message: "again" });
    expect(screen.getByText("Noted: Hello there")).toBeTruthy();
  });

  it("keeps the first message on screen while it gets its ID", async () => {
    const server = new FakeServer();
    server.events = [{ type: "chat", chatId: "c-new", title: "Zebra flicker" }];
    server.hang = true;
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    const removed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (node instanceof Element && node.textContent?.includes("You: Zebra flicker")) removed.push(node.outerHTML);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    send("Zebra flicker");
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-new" }));
    observer.disconnect();
    expect(screen.getByText("Zebra flicker", { selector: "div" })).toBeTruthy();
    expect(removed).toEqual([]);
  });

  it("takes the place of the new one in the history, so Back leaves the chat", async () => {
    const server = new FakeServer();
    start(server, ["/", "/chat"]);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    send("Hello there");
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-new" }));
    act(() => back());
    await waitFor(() => expect(where).toBe("/"));
  });

  it("is what New conversation opens", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    expect(screen.queryByText("Groceries please")).toBeNull();
  });
});

describe("stopping a new conversation before it has its ID", () => {
  it("leaves nothing of it in the next one", async () => {
    const server = new FakeServer();
    server.hang = true;
    server.events = [];
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    send("buy milk");
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(server.stopped).toBe(true));
    expect(await screen.findByText("Stopped.")).toBeTruthy();

    server.hang = false;
    server.events = [{ type: "chat", chatId: "c-two", title: "and eggs" }, { type: "text", text: "Noted: and eggs" }, { type: "done" }];
    send("and eggs");
    expect(await screen.findByText("Noted: and eggs")).toBeTruthy();
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-two" }));
    expect(screen.queryByText("buy milk")).toBeNull();
    expect(server.bodies[1]).toEqual({ spaceId: PERSONAL, message: "and eggs" });
  });

  it("stops it when New conversation is chosen, so it does not open again", async () => {
    const server = new FakeServer();
    server.hang = true;
    server.events = [{ type: "chat", chatId: "c-one", title: "buy milk" }];
    server.entries["c-one"] = [{ kind: "user", text: "buy milk" }];
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    send("buy milk");
    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("button", { name: "New conversation" }));
    release();
    await waitFor(() => expect(server.stopped).toBe(true));
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    expect(searchOf()).toEqual({ space: PERSONAL });
    expect(screen.queryByText("buy milk", { selector: "div" })).toBeNull();
  });
});

describe("changing the space", () => {
  it("starts afresh in that space and lists that space's conversations", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Family" }));
    await waitFor(() => expect(searchOf()).toEqual({ space: FAMILY }));
    expect(screen.queryByText("Keep notes for me")).toBeNull();
    expect(await within(conversations()).findByRole("link", { name: /Holiday list/ })).toBeTruthy();
    expect(within(conversations()).queryByRole("link", { name: /Plan the week/ })).toBeNull();
    expect(server.requests).toContain(`GET /api/spaces/${FAMILY}/chats`);

    // A message there starts a conversation of that space, with nothing of the other.
    server.events = [{ type: "text", text: "Noted: packing" }, { type: "done" }];
    send("packing");
    expect(await screen.findByText("Noted: packing")).toBeTruthy();
    expect(server.bodies).toEqual([{ spaceId: FAMILY, message: "packing" }]);
  });
});

describe("the link from an app (docs/center.md, \"The chat link\")", () => {
  const textarea = () => document.querySelector("textarea")!;

  it("begins a message about the app in the box, sends nothing, and drops the app from the address", async () => {
    const server = new FakeServer();
    start(server, ["/apps", `/chat?space=${PERSONAL}&app=m-notes`]);
    await waitFor(() => expect(textarea().value).toBe("Change “Notes”: "));
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    // Ready to finish the sentence: the focus in the box, the cursor after the text.
    await waitFor(() => expect(document.activeElement).toBe(textarea()));
    expect(textarea().selectionStart).toBe("Change “Notes”: ".length);
    expect(server.requests.some((request) => request.startsWith("POST"))).toBe(false);
    // In place of the address with the app, so Back leaves the chat.
    act(() => back());
    await waitFor(() => expect(where).toBe("/apps"));
  });

  it("names the app in the person's language", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    start(server, `/chat?space=${PERSONAL}&app=m-notes`);
    await waitFor(() => expect(textarea().value).toBe("修改「笔记」："));
  });

  it("fills nothing for an app the space does not hold", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${FAMILY}&app=m-notes`);
    await waitFor(() => expect(searchOf()).toEqual({ space: FAMILY }));
    expect(textarea().value).toBe("");
  });
});

describe("leaving a conversation while it answers", () => {
  it("stops the turn, and nothing of it shows in the conversation opened next", async () => {
    const server = new FakeServer();
    server.hang = true;
    server.events = [{ type: "text", text: "Thinking about it" }];
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    send("and milk");
    expect(await screen.findByText("Thinking about it")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Family" }));
    await waitFor(() => expect(server.stopped).toBe(true));
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByText("Thinking about it")).toBeNull();
    expect(screen.queryByText("Stopped.")).toBeNull();
  });
});

describe("deleting a conversation", () => {
  it("asks first, and deleting the open one starts a new one", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();

    fireEvent.click(within(conversations()).getByRole("button", { name: "Delete conversation Plan the week" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete this conversation?" });
    expect(within(dialog).getByText("It cannot be undone. What the model made stays.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.requests.some((request) => request.startsWith("DELETE"))).toBe(false);

    fireEvent.click(within(conversations()).getByRole("button", { name: "Delete conversation Plan the week" }));
    dialog = await screen.findByRole("dialog", { name: "Delete this conversation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(conversations()).queryByRole("link", { name: /Plan the week/ })).toBeNull());
    expect(server.requests).toContain(`DELETE /api/spaces/${PERSONAL}/chats/c-recent`);
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    expect(screen.queryByText("Keep notes for me")).toBeNull();
    expect(within(conversations()).getByRole("link", { name: /Groceries/ })).toBeTruthy();
  });

  it("gives focus to New conversation once the deleted one's row is gone", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    const trash = within(conversations()).getByRole("button", { name: "Delete conversation Groceries" });
    expect(trash.getAttribute("aria-haspopup")).toBe("dialog");
    trash.focus();
    fireEvent.click(trash);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(conversations()).queryByRole("link", { name: /Groceries/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(conversations()).getByRole("button", { name: "New conversation" })));
  });

  it("takes the deleted one's place in the history", async () => {
    const server = new FakeServer();
    start(server, ["/", `/chat?space=${PERSONAL}&chat=c-recent`]);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("button", { name: "Delete conversation Plan the week" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this conversation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    act(() => back());
    await waitFor(() => expect(where).toBe("/"));
  });

  it("leaves the open conversation open when another one is deleted", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("button", { name: "Delete conversation Groceries" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(conversations()).queryByRole("link", { name: /Groceries/ })).toBeNull());
    expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-recent" });
    expect(screen.getByText("Keep notes for me")).toBeTruthy();
  });
});

describe("a message the server turns down", () => {
  it("in a conversation that is gone: says so, puts the message back and starts a new one", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    server.refuse = { status: 404, message: "Not found." };
    send("still there?");
    expect(await screen.findByText("This conversation is gone.")).toBeTruthy();
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    expect((box() as HTMLTextAreaElement).value).toBe("still there?");
  });

  it("while it answers elsewhere", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    server.refuse = { status: 409, message: "This conversation is still answering, in another window or tab." };
    send("and eggs");
    expect(await screen.findByText("This conversation is still answering, in another window or tab.")).toBeTruthy();
    expect((box() as HTMLTextAreaElement).value).toBe("and eggs");
    // What was refused is not shown as said.
    expect(screen.queryByText("and eggs", { selector: "div" })).toBeNull();
    expect(searchOf()).toEqual({ space: PERSONAL, chat: "c-older" });
  });

  it("when it is full, with a way to start a new one", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    server.refuse = { status: 409, message: "This conversation is full. Start a new one." };
    send("one more");
    const said = await screen.findByText("This conversation is full. Start a new one.");
    fireEvent.click(within(said.parentElement!).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    expect((box() as HTMLTextAreaElement).value).toBe("one more");
  });

  it("when the person has too many conversations for a new one", async () => {
    const server = new FakeServer();
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    server.refuse = { status: 409, message: "You have 500 conversations here. Delete some to start a new one." };
    send("hello");
    expect(await screen.findByText("You have 500 conversations here. Delete some to start a new one.")).toBeTruthy();
  });
});

describe("a notice of the server", () => {
  it("does not show again after the person leaves the conversation and comes back", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    server.refuse = { status: 409, message: "This conversation is still answering, in another window or tab." };
    send("and eggs");
    expect(await screen.findByText("This conversation is still answering, in another window or tab.")).toBeTruthy();
    server.refuse = null;
    fireEvent.click(within(conversations()).getByRole("link", { name: /Plan the week/ }));
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("link", { name: /Groceries/ }));
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    expect(screen.queryByText("This conversation is still answering, in another window or tab.")).toBeNull();
  });

  it("that a conversation is gone does not show again on the next new conversation", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-deleted`);
    expect(await screen.findByText("This conversation is gone.")).toBeTruthy();
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    fireEvent.click(within(conversations()).getByRole("link", { name: /Groceries/ }));
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    fireEvent.click(within(conversations()).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    expect(screen.queryByText("This conversation is gone.")).toBeNull();
  });
});

describe("on a phone", () => {
  it("opens the list in a dialog, and closes it once a conversation is chosen", async () => {
    const server = new FakeServer();
    start(server);
    fireEvent.click(await screen.findByRole("button", { name: "Conversations" }));
    const dialog = await screen.findByRole("dialog", { name: "Conversations" });
    fireEvent.click(await within(dialog).findByRole("link", { name: /Groceries/ }));
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("a new conversation, before anything is said", () => {
  it("greets the person and offers examples; one clicked goes into the box, to send or change, and is not sent", async () => {
    const server = new FakeServer();
    start(server);
    expect(await screen.findByRole("heading", { level: 2, name: "What would you like to make?" })).toBeTruthy();
    expect(screen.getByText(/Describe what you want to keep track of/)).toBeTruthy();
    const examples = screen.getByRole("group", { name: "Examples" });
    const chips = within(examples).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "A list of books I want to read",
      "Track my runs: how far and how long",
      "A chore rota for the family",
      "A ledger for my daily spending",
    ]);
    const chore = within(examples).getByRole("button", { name: "A chore rota for the family" });
    await waitFor(() => expect((chore as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(chore);
    expect((box() as HTMLTextAreaElement).value).toBe("A chore rota for the family");
    expect(document.activeElement).toBe(box());
    expect((box() as HTMLTextAreaElement).selectionStart).toBe("A chore rota for the family".length);
    expect(server.bodies).toEqual([]);
    expect(server.requests.some((request) => request.startsWith("POST"))).toBe(false);

    // Sent, it is a conversation: the greeting goes.
    send("A chore rota for the family");
    expect(await screen.findByText("Noted: Hello there")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What would you like to make?" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Examples" })).toBeNull();
  });

  it("is not what an open conversation shows: no greeting, no examples, no introduction", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What would you like to make?" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Examples" })).toBeNull();
    expect(screen.queryByText(/Describe what you want to keep track of/)).toBeNull();
  });

  it("asks for a model first, in place of the examples, when the person has none", async () => {
    const server = new FakeServer();
    server.hasKey = false;
    start(server);
    expect(await screen.findByRole("link", { name: "Choose your model" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What would you like to make?" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Examples" })).toBeNull();
    expect((box() as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("offers to allow the assistant, in place of the examples, where it is off", async () => {
    const server = new FakeServer();
    server.personalAssistant = "none";
    start(server);
    expect(await screen.findByRole("button", { name: "Allow it here" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Examples" })).toBeNull();
    expect((box() as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe("the box to write in", () => {
  it("sends on Enter, and not on Shift+Enter or while a character is being composed", async () => {
    const server = new FakeServer();
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "Hello there" } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(server.bodies).toEqual([]);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(await screen.findByText("Noted: Hello there")).toBeTruthy();
    expect(server.bodies).toEqual([{ spaceId: PERSONAL, message: "Hello there" }]);
    expect((box() as HTMLTextAreaElement).value).toBe("");
  });

  it("says the model is working, for screen readers too, while a turn runs, and offers Stop in place of Send", async () => {
    const server = new FakeServer();
    server.hang = true;
    server.events = [];
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    send("and milk");
    const working = await screen.findByText("Working…");
    expect(working.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped.")).toBeTruthy();
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});

describe("what is said", () => {
  it("draws the model's replies from Markdown, and the person's own words as they wrote them", async () => {
    const server = new FakeServer();
    server.events = [
      { type: "chat", chatId: "c-new", title: "List" },
      { type: "text", text: "Here is **your list**:\n\n- milk\n- eggs\n\nSee [the docs](https://example.com/docs)." },
      { type: "done" },
    ];
    start(server);
    await within(await listed()).findByRole("link", { name: /Plan the week/ });
    send("Make it **bold** <b>please</b>");
    const strong = await screen.findByText("your list");
    expect(strong.tagName).toBe("STRONG");
    const reply = strong.closest("[aria-live]") as HTMLElement;
    expect(within(reply).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["milk", "eggs"]);
    const link = within(reply).getByRole("link", { name: "the docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    // What the person wrote is not Markdown, nor HTML.
    const said = screen.getByText("Make it **bold** <b>please</b>", { selector: "div" });
    expect(said.querySelector("strong, b")).toBeNull();
    expect(document.querySelectorAll("strong")).toHaveLength(1);
  });

  it("draws a reply kept from before from Markdown too", async () => {
    const server = new FakeServer();
    server.entries["c-older"] = [
      { kind: "user", text: "Groceries please" },
      { kind: "model", text: "Done:\n\n1. *Milk*\n2. `Eggs`" },
    ];
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    const milk = await screen.findByText("Milk");
    expect(milk.tagName).toBe("EM");
    expect(screen.getByText("Eggs").tagName).toBe("CODE");
  });
});

describe("the list's parts by day", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts each conversation under Today, Yesterday, Previous 7 days or Older, on the reader's clock, with a time or a short date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 12, 0));
    const at = (day: number, hours: number, minutes: number, month = 11) => new Date(2026, month - 1, day, hours, minutes).toISOString();
    const server = new FakeServer();
    server.chats[PERSONAL] = [
      summary("c-today", "Plan the week", at(23, 9, 5)),
      summary("c-yesterday", "Groceries", at(22, 20, 0)),
      summary("c-week", "Garden", at(19, 8, 0)),
      summary("c-old", "Books", at(1, 8, 0)),
      summary("c-older", "Recipes", at(30, 8, 0, 10)),
    ];
    start(server);
    const list = await listed();
    await within(list).findByRole("link", { name: /Plan the week/ });
    expect(within(list).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 days",
      "Older",
    ]);
    const under = (heading: string) =>
      within(within(list).getByRole("heading", { level: 3, name: heading }).parentElement!)
        .getAllByRole("link")
        .map((link) => [link.querySelector(".clip")?.textContent, link.querySelector("time")?.textContent]);
    expect(under("Today")).toEqual([["Plan the week", "09:05"]]);
    expect(under("Yesterday")).toEqual([["Groceries", "Nov 22"]]);
    expect(under("Previous 7 days")).toEqual([["Garden", "Nov 19"]]);
    expect(under("Older")).toEqual([
      ["Books", "Nov 1"],
      ["Recipes", "Oct 30"],
    ]);
  });
});

describe("the top bar", () => {
  it("names the open conversation, and the page for a new one, and starts a new one from its own button", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    const bar = screen.getByRole("banner");
    await waitFor(() => expect(within(bar).getByRole("heading", { level: 1 }).textContent).toBe("Plan the week"));
    expect(document.title).toBe("Plan the week · Hearth");

    fireEvent.click(within(bar).getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(searchOf()).toEqual({ space: PERSONAL }));
    expect(screen.queryByText("Keep notes for me")).toBeNull();
    expect(within(bar).getByRole("heading", { level: 1 }).textContent).toBe("Chat");
    expect(within(bar).getByRole("button", { name: "Conversations" }).getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("names the page where the list is beside the conversation, which marks the open one; the tab still names the conversation", async () => {
    // The main column as wide as on a computer: (jsdom lays nothing out, and measures everything 0 wide.)
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
    try {
      const server = new FakeServer();
      start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
      expect(await screen.findByText("Keep notes for me")).toBeTruthy();
      await waitFor(() => expect(document.title).toBe("Plan the week · Hearth"));
      expect(within(screen.getByRole("banner")).getByRole("heading", { level: 1 }).textContent).toBe("Chat");
    } finally {
      measure.mockRestore();
    }
  });
});

describe("in Chinese", () => {
  it("names the list, a new conversation and each delete button in Chinese, and asks in Chinese", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    start(server);
    const list = await screen.findByRole("navigation", { name: "对话记录" });
    expect(within(list).getByRole("button", { name: "新对话" })).toBeTruthy();
    fireEvent.click(await within(list).findByRole("button", { name: "删除对话“Groceries”" }));
    const dialog = await screen.findByRole("dialog", { name: "删除这个对话？" });
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeTruthy();
  });
});

describe("an open conversation where the box is off", () => {
  it("says the assistant is off above the box, and allowing it there opens the box", async () => {
    const server = new FakeServer();
    server.personalAssistant = "none";
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    const allow = await screen.findByRole("button", { name: "Allow it here" });
    expect(screen.getByText("Your model may not change anything in this space yet.")).toBeTruthy();
    expect((box() as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(allow);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow it here" })).toBeNull());
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false));
    expect(server.requests).toContain(`PUT /api/spaces/${PERSONAL}/assistant`);
    // Still the conversation: no greeting, no examples.
    expect(screen.getByText("Keep notes for me")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Examples" })).toBeNull();
  });

  it("asks for a model above the box when the person has none", async () => {
    const server = new FakeServer();
    server.hasKey = false;
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Choose your model" })).toBeTruthy();
    expect((box() as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe("the greeting", () => {
  it("balances its lines, so that no word or two is left alone on the last", async () => {
    const server = new FakeServer();
    start(server);
    const heading = await screen.findByRole("heading", { level: 2, name: "What would you like to make?" });
    expect(heading.className).toContain("text-balance");
    expect(screen.getByText(/Describe what you want to keep track of/).className).toContain("text-balance");
  });
});

describe("what a screen reader hears", () => {
  /** The live region of the conversation that `inside` is in. */
  const regionOf = (inside: HTMLElement) => inside.closest(".overflow-y-auto")!.querySelector<HTMLElement>('[aria-live="polite"]');
  const hidden = /(^|\s)(empty:)?hidden(\s|$)/;

  it("has the live region on the page before the first message of a visit, so that it and Working… are announced", async () => {
    const server = new FakeServer();
    server.hang = true;
    server.events = [];
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    const region = regionOf(screen.getByText("Groceries please"));
    expect(region).not.toBeNull();
    // Empty, it is still drawn (jsdom applies no :empty rule: the class stands in for it).
    expect(region!.className).not.toMatch(hidden);
    send("and milk");
    expect((await screen.findByText("Working…")).closest("[aria-live]")).toBe(region);
    expect(screen.getByText("and milk", { selector: "div" }).closest("[aria-live]")).toBe(region);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped.")).toBeTruthy();
  });

  it("has it in a new conversation too, before anything is said", async () => {
    const server = new FakeServer();
    start(server);
    const greeting = await screen.findByRole("heading", { level: 2, name: "What would you like to make?" });
    const region = regionOf(greeting);
    expect(region).not.toBeNull();
    expect(region!.className).not.toMatch(hidden);
    await waitFor(() => expect((box() as HTMLTextAreaElement).disabled).toBe(false));
    send("Hello there");
    expect((await screen.findByText("Noted: Hello there")).closest("[aria-live]")).toBe(region);
  });

  it("can reach the conversation from the keyboard, as a named region that scrolls", async () => {
    const server = new FakeServer();
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    const log = screen.getByRole("region", { name: "Messages" });
    expect(log.tabIndex).toBe(0);
    expect(log.className).toContain("overflow-y-auto");
    expect(within(log).getByText("Keep notes for me")).toBeTruthy();
  });

  it("names the region in Chinese too", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    expect(await screen.findByText("Keep notes for me")).toBeTruthy();
    expect(screen.getByRole("region", { name: "消息" })).toBeTruthy();
  });
});

describe("reading back while a turn runs", () => {
  it("is not taken to the end when the turn ends with nothing new", async () => {
    const server = new FakeServer();
    let end = () => {};
    server.finish = new Promise<void>((resolve) => (end = resolve));
    server.events = [{ type: "text", text: "Noted: and milk" }];
    start(server, `/chat?space=${PERSONAL}&chat=c-older`);
    expect(await screen.findByText("Groceries please")).toBeTruthy();
    const view = screen.getByText("Groceries please").closest<HTMLElement>(".overflow-y-auto")!;
    let top = 0;
    Object.defineProperty(view, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(view, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(view, "scrollTop", { configurable: true, get: () => top, set: (value: number) => (top = value) });
    send("and milk");
    expect(await screen.findByText("Noted: and milk")).toBeTruthy();
    expect(top).toBe(1000); // a new entry still goes to the end
    top = 100; // the person scrolls up to read
    fireEvent.scroll(view);
    act(() => end());
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    expect(top).toBe(100);
  });
});

describe("a request of the model's to delete", () => {
  const LEDGER_PREVIEW = ["Lunch · 12.50", "Coffee · 3.20", "Bus · 2.80", "Books · 30", "Cinema · 11"];
  const requested = (fields: Partial<Extract<ChatEntry, { kind: "action" }>> = {}): Extract<ChatEntry, { kind: "action" }> => ({
    kind: "action",
    action: "delete_requested",
    appId: "m-notes",
    appName: "Ledger",
    confirmationId: "q-1",
    collection: "entries",
    count: 7,
    preview: LEDGER_PREVIEW,
    ...fields,
  });
  /** The conversation "Plan the week", holding the request. */
  function withRequest(server: FakeServer, entry = requested(), result: ConfirmationResult = { status: "pending", deleted: 7 }) {
    server.entries["c-recent"] = [{ kind: "user", text: "delete last week" }, entry];
    server.confirmations[entry.confirmationId!] = result;
  }
  const card = (name: string | RegExp) => screen.findByRole("group", { name });

  it("shows what would go, a few words of each row, with Delete and Cancel, and deletes nothing by itself", async () => {
    const server = new FakeServer();
    server.events = [
      { type: "chat", chatId: "c-new", title: "delete last week" },
      { type: "action", action: "delete_requested", appId: "m-notes", appName: "Ledger", confirmationId: "q-1", collection: "entries", count: 7, preview: LEDGER_PREVIEW, status: "pending" },
      { type: "text", text: "I asked you first." },
      { type: "done" },
    ];
    server.confirmations["q-1"] = { status: "pending", deleted: 7 };
    start(server);
    await listed();
    send("delete last week");

    const box = await card("Delete 7 entries from “Ledger”?");
    expect(within(box).getAllByRole("listitem").map((item) => item.textContent)).toEqual(LEDGER_PREVIEW);
    expect(within(box).getByText("and 2 more")).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(await screen.findByText("I asked you first.")).toBeTruthy();
    // Nothing was answered, nothing changed: no page was told to read again.
    expect(server.requests.filter((request) => request.includes("/confirmations/"))).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("deletes once the person confirms: the buttons wait while it is sent, then the card says how many went", async () => {
    const server = new FakeServer();
    withRequest(server);
    let open = () => {};
    server.answerGate = new Promise((resolve) => (open = resolve));
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);

    const box = await card("Delete 7 entries from “Ledger”?");
    const remove = within(box).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(remove.disabled).toBe(true));
    expect((within(box).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(box.getAttribute("aria-busy")).toBe("true");
    open();

    const said = await within(box).findByRole("status");
    expect(said.textContent).toBe("Deleted 7 entries.");
    expect(within(box).queryByRole("button")).toBeNull();
    // The buttons went: focus goes to what the card says now.
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(server.requests).toContain(`POST /api/spaces/${PERSONAL}/chats/c-recent/confirmations/q-1`);
    expect(server.bodies.at(-1)).toEqual({ decision: "confirm" });
    // The app's pages on screen read their rows again.
    expect(notified).toEqual(["m-notes"]);
  });

  it("keeps everything when the person cancels", async () => {
    const server = new FakeServer();
    withRequest(server, requested({ count: 1, preview: ["Lunch · 12.50"] }), { status: "pending", deleted: 1 });
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);

    const box = await card("Delete 1 entry from “Ledger”?");
    expect(within(box).queryByText(/more/)).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
    expect((await within(box).findByRole("status")).textContent).toBe("Kept: nothing was deleted.");
    expect(within(box).queryByRole("button")).toBeNull();
    expect(server.bodies.at(-1)).toEqual({ decision: "decline" });
    expect(notified).toEqual([]);
  });

  it("shows a request kept from before as it stands now, after a reload or on another device", async () => {
    const server = new FakeServer();
    server.entries["c-recent"] = [
      requested({ confirmationId: "q-done", count: 3 }),
      requested({ confirmationId: "q-one", count: 1, preview: ["Lunch"] }),
      requested({ confirmationId: "q-gone", count: 2 }),
      requested({ confirmationId: "q-no", count: 2 }),
      requested({ confirmationId: "q-old", count: 2 }),
      requested({ confirmationId: "q-wait", count: 2 }),
    ];
    server.confirmations = {
      "q-done": { status: "confirmed", deleted: 3 },
      "q-one": { status: "confirmed", deleted: 1 },
      "q-gone": { status: "confirmed", deleted: 0 },
      "q-no": { status: "declined", deleted: 0 },
      "q-old": { status: "expired", deleted: 0 },
      "q-wait": { status: "pending", deleted: 2 },
    };
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);

    const cards = await screen.findAllByRole("group", { name: /^Delete \d+ entr(y|ies) from “Ledger”\?$/ });
    expect(cards.map((one) => within(one).queryByRole("status")?.textContent ?? "buttons")).toEqual([
      "Deleted 3 entries.",
      "Deleted 1 entry.",
      "Nothing was deleted: those entries were gone already.",
      "Kept: nothing was deleted.",
      "This request expired. Nothing was deleted.",
      "buttons",
    ]);
    expect(cards.slice(0, 5).every((one) => within(one).queryByRole("button") === null)).toBe(true);
    expect(within(cards[5]!).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("says the request expired when the server finds it too old as it is answered", async () => {
    const server = new FakeServer();
    withRequest(server);
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    const box = await card("Delete 7 entries from “Ledger”?");
    server.confirmations["q-1"] = { status: "pending", deleted: 0 };
    // The stand-in answers as the server does for a request past its 24 hours.
    server.answer = ((original) => (path: string, init: RequestInit) =>
      path.includes("/confirmations/")
        ? new Response(JSON.stringify({ status: "expired", deleted: 0 }), { status: 200, headers: { "Content-Type": "application/json" } })
        : original(path, init))(server.answer.bind(server));
    fireEvent.click(within(box).getByRole("button", { name: "Delete" }));
    expect((await within(box).findByRole("status")).textContent).toBe("This request expired. Nothing was deleted.");
    expect(notified).toEqual([]);
  });

  it("says why an answer was not taken, and keeps the buttons: access lost, the app changed, the request gone, no connection", async () => {
    const server = new FakeServer();
    withRequest(server);
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    const box = await card("Delete 7 entries from “Ledger”?");
    const tries: Array<[{ status: number; code: string }, string]> = [
      [{ status: 403, code: "forbidden" }, "Nothing was deleted: you, or your model, may no longer change this app here."],
      [{ status: 409, code: "conflict" }, "Nothing was deleted: the app has changed since. Ask your model again."],
      [{ status: 404, code: "not_found" }, "This request is gone. Nothing was deleted."],
      [{ status: 500, code: "internal" }, "Your answer could not be sent. Try again."],
    ];
    for (const [refuse, message] of tries) {
      server.confirmations["q-1"] = { status: "pending", deleted: 7, refuse };
      fireEvent.click(within(box).getByRole("button", { name: "Delete" }));
      expect((await within(box).findByRole("alert")).textContent).toBe(message);
      expect((within(box).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(within(box).queryByRole("status")).toBeNull();
    expect(notified).toEqual([]);
  });

  it("shows the answer given elsewhere when the server says it was answered already", async () => {
    const server = new FakeServer();
    withRequest(server);
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    const box = await card("Delete 7 entries from “Ledger”?");
    // Meanwhile it was declined on another device.
    server.confirmations["q-1"] = { status: "declined", deleted: 0 };
    fireEvent.click(within(box).getByRole("button", { name: "Delete" }));
    expect((await within(box).findByRole("status")).textContent).toBe("Kept: nothing was deleted.");
    expect(within(box).queryByRole("alert")).toBeNull();
    expect(within(box).queryByRole("button")).toBeNull();
  });

  it("speaks Chinese, the rows' own words left as they are", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    withRequest(server, requested({ appName: "账本" }));
    start(server, `/chat?space=${PERSONAL}&chat=c-recent`);
    const box = await card("要从「账本」删除 7 条数据吗？");
    expect(within(box).getByText("还有 2 条")).toBeTruthy();
    expect(within(box).getByText("Lunch · 12.50")).toBeTruthy();
    expect(within(box).getByRole("button", { name: "取消" })).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "删除" }));
    expect((await within(box).findByRole("status")).textContent).toBe("已删除 7 条数据。");
  });
});
