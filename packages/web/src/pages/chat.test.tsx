/**
 * The chat page and the conversations the server keeps (docs/platform.md,
 * "The chat"): the list of the person's own conversations in a space,
 * opening one, a new one getting its ID, changing the space, deleting, and
 * what the page says when the server turns a message down. The whole web
 * app is drawn against a stand-in for the server.
 */
import type { AppSummary, ChatEntry, ChatEvent, ChatSummary, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

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
  requests: string[] = [];
  bodies: unknown[] = [];
  apps: AppSummary[] = [NOTES];

  session(): Session {
    const me = { id: "u1", name: "Sam Example", role: "owner" as const };
    return {
      user: { id: "u1", email: "sam@example.com", name: "Sam Example", locale: this.locale, theme: "light" },
      spaces: [
        { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, members: [me], assistant: "edit" },
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
    if (path === "/api/me/model") return json({ protocol: "openai", baseUrl: "https://api.example.com/v1", model: "sample", hasKey: true });
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
      return json({ chat, entries: this.entries[chat.id] ?? [] });
    }
    if (path === "/api/chat" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { spaceId: string; chatId?: string; message: string };
      this.bodies.push(body);
      if (this.refuse) return refused(this.refuse.status, this.refuse.message);
      const started = this.events.find((event) => event.type === "chat");
      if (started?.type === "chat") this.chats[body.spaceId]!.unshift(summary(started.chatId, started.title, "2026-11-23T09:00:00.000Z"));
      const text = this.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const hang = this.hang;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(text));
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
const box = () => screen.getByRole("textbox", { name: /For example/ });
const send = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};
const searchOf = () => Object.fromEntries(new URL(where, "http://localhost").searchParams);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
