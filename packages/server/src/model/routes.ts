/**
 * The routes of each person's own model and of the chat
 * (docs/platform.md): `/api/me/model` to save, read back and forget the
 * model, and `POST /api/chat`, whose answer is a stream of server-sent
 * events (`ChatEvent` in @hearth/shared).
 */
import { chatRequestSchema, modelSettingsRequestSchema, type ChatEvent } from "@hearth/shared";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Registry } from "../apps/registry";
import type { Config } from "../config";
import type { Db } from "../db/database";
import { membershipOf } from "../db/people";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { notFound } from "../http/errors";
import { runChat } from "./chat";
import { deleteModelSettings, readModelSettings, saveModelSettings } from "./settings";

/** How often an open chat says it is still there, so that no proxy between takes it for dead. */
const PING_MS = 15_000;

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

  app.get("/api/me/model", requireMember, (c) => c.json(readModelSettings(db, c.get("user").id)));

  app.put("/api/me/model", requireMember, async (c) => {
    const request = await readBody(c, modelSettingsRequestSchema);
    return c.json(saveModelSettings(db, config, c.get("user").id, request));
  });

  app.delete("/api/me/model", requireMember, (c) => {
    deleteModelSettings(db, c.get("user").id);
    return c.body(null, 204);
  });

  app.post("/api/chat", requireMember, async (c) => {
    const request = await readBody(c, chatRequestSchema);
    const user = c.get("user");
    if (!membershipOf(db, user.id, request.spaceId)) throw notFound();
    return streamSSE(c, async (stream) => {
      const stop = new AbortController();
      stream.onAbort(() => stop.abort());
      const send = (event: ChatEvent) => stream.writeSSE({ data: JSON.stringify(event) });
      const ping = setInterval(() => void send({ type: "ping" }).catch(() => {}), PING_MS);
      try {
        await runChat(deps, user, request, send, stop.signal);
      } catch (error) {
        if (!stop.signal.aborted) {
          deps.logError(error);
          await send({ type: "error", failure: "model_failed", detail: "Something went wrong on the server." }).catch(() => {});
        }
      } finally {
        clearInterval(ping);
      }
    });
  });
}
