/**
 * The routes of each person's own model and of the chat
 * (docs/platform.md): `/api/me/model` to save, read back and forget the
 * model; `/api/spaces/:spaceId/chats` for the person's own conversations
 * in a space; and `POST /api/chat`, whose answer is a stream of server-sent
 * events (`ChatEvent` in @hearth/shared), kept with the conversation as they
 * are sent.
 */
import {
  chatRequestSchema,
  modelSettingsRequestSchema,
  type ChatEntry,
  type ChatEvent,
  type ChatList,
  type ChatSummary,
} from "@hearth/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Registry } from "../apps/registry";
import type { Config } from "../config";
import type { Db } from "../db/database";
import { membershipOf } from "../db/people";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { notFound, Refusal } from "../http/errors";
import { runChat } from "./chat";
import {
  MAX_ENTRIES,
  appendEntry,
  countEntries,
  createChat,
  deleteChat,
  findChat,
  historyFor,
  listChats,
  readChat,
  titleOf,
  type ChatScope,
} from "./chats";
import { deleteModelSettings, readModelSettings, saveModelSettings } from "./settings";

/** How often an open chat says it is still there, so that no proxy between takes it for dead. */
const PING_MS = 15_000;

/** What of an event is kept with the conversation: "text", "action" and "error"; "chat", "done" and "ping" are not. */
function entryOf(event: ChatEvent): ChatEntry | null {
  switch (event.type) {
    case "text":
      return { kind: "model", text: event.text };
    case "action": {
      const { action, appId, appName, version, previous, restored } = event;
      return {
        kind: "action",
        action,
        appId,
        appName,
        ...(version !== undefined ? { version } : {}),
        ...(previous !== undefined ? { previous } : {}),
        ...(restored !== undefined ? { restored } : {}),
      };
    }
    case "error":
      return { kind: "failure", failure: event.failure, detail: event.detail };
    default:
      return null;
  }
}

/** Thrown into the run when its conversation was deleted while it answered: the run stops, and nothing more is kept. */
class ChatGone extends Error {
  constructor() {
    super("The conversation was deleted while it answered.");
    this.name = "ChatGone";
  }
}

export function registerModelRoutes(
  app: Hono<Env>,
  deps: {
    db: Db;
    registry: Registry;
    config: Pick<Config, "secret" | "auth" | "modelStandIn">;
    requireMember: RequireMember;
    logError: (error: unknown) => void;
    fetch?: typeof fetch;
  },
): void {
  const { db, config, requireMember } = deps;
  /** The conversations answering now, on this server: one run per conversation at a time. */
  const answering = new Set<string>();

  app.get("/api/me/model", requireMember, (c) => c.json(readModelSettings(db, c.get("user").id)));

  app.put("/api/me/model", requireMember, async (c) => {
    const request = await readBody(c, modelSettingsRequestSchema);
    return c.json(saveModelSettings(db, config, c.get("user").id, request));
  });

  app.delete("/api/me/model", requireMember, (c) => {
    deleteModelSettings(db, c.get("user").id);
    return c.body(null, 204);
  });

  /** The person's own conversations in the space of the address; 404 when they are not in it. */
  const scopeOf = (userId: string, spaceId: string): ChatScope => {
    if (!membershipOf(db, userId, spaceId)) throw notFound();
    return { spaceId, userId };
  };

  app.get("/api/spaces/:spaceId/chats", requireMember, (c) => {
    const scope = scopeOf(c.get("user").id, c.req.param("spaceId"));
    return c.json({ chats: listChats(db, scope) } satisfies ChatList);
  });

  app.get("/api/spaces/:spaceId/chats/:chatId", requireMember, (c) => {
    const scope = scopeOf(c.get("user").id, c.req.param("spaceId"));
    const chat = readChat(db, { ...scope, chatId: c.req.param("chatId") });
    if (!chat) throw notFound();
    return c.json(chat);
  });

  app.delete("/api/spaces/:spaceId/chats/:chatId", requireMember, (c) => {
    const scope = scopeOf(c.get("user").id, c.req.param("spaceId"));
    if (!deleteChat(db, { ...scope, chatId: c.req.param("chatId") })) throw notFound();
    return c.body(null, 204);
  });

  app.post("/api/chat", requireMember, async (c) => {
    const request = await readBody(c, chatRequestSchema);
    const user = c.get("user");
    const now = () => new Date().toISOString();
    // The checks and the person's message, kept before the model is asked, in one transaction.
    const { scope, chatId, started } = db.transaction(() => {
      const scope = scopeOf(user.id, request.spaceId);
      if (request.chatId === undefined) {
        const chat = createChat(db, { ...scope, title: titleOf(request.message), now: now() });
        appendEntry(db, { ...scope, chatId: chat.id, entry: { kind: "user", text: request.message }, now: chat.createdAt });
        return { scope, chatId: chat.id, started: chat as ChatSummary | null };
      }
      const chatId = request.chatId;
      if (!findChat(db, { ...scope, chatId })) throw notFound();
      if (answering.has(chatId)) {
        throw new Refusal(409, "conflict", "This conversation is still answering, in another window or tab.");
      }
      if (countEntries(db, { ...scope, chatId }) >= MAX_ENTRIES) {
        throw new Refusal(409, "conflict", "This conversation is full. Start a new one.");
      }
      appendEntry(db, { ...scope, chatId, entry: { kind: "user", text: request.message }, now: now() });
      return { scope, chatId, started: null };
    }).immediate();
    answering.add(chatId);

    try {
      const history = historyFor(readChat(db, { ...scope, chatId })?.entries ?? []);
      return streamSSE(c, async (stream) => {
        const stop = new AbortController();
        stream.onAbort(() => stop.abort());
        const write = (event: ChatEvent) => stream.writeSSE({ data: JSON.stringify(event) });
        // Kept as it is sent, in order; once the conversation is gone, the run stops at its next entry.
        let gone = false;
        const send = async (event: ChatEvent) => {
          const entry = entryOf(event);
          if (entry !== null) {
            if (gone || !appendEntry(db, { ...scope, chatId, entry, now: now() })) {
              gone = true;
              stop.abort();
              throw new ChatGone();
            }
          }
          await write(event);
        };
        const ping = setInterval(() => void write({ type: "ping" }).catch(() => {}), PING_MS);
        try {
          if (started) await write({ type: "chat", chatId, title: started.title });
          await runChat(deps, user, { spaceId: scope.spaceId, history }, send, stop.signal);
        } catch (error) {
          if (!stop.signal.aborted) {
            deps.logError(error);
            await send({ type: "error", failure: "model_failed", detail: "Something went wrong on the server." }).catch(() => {});
          }
        } finally {
          clearInterval(ping);
          answering.delete(chatId);
        }
      });
    } catch (error) {
      answering.delete(chatId);
      throw error;
    }
  });
}
