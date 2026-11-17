/**
 * The routes of apps made in Hearth (docs/platform.md): the page the
 * sandbox shows, and the rows its bridge reads and writes through the page
 * around it. Who may do what is decided as for every app, by VISIBLE.
 */
import { addFromCatalogRequestSchema, madeRowWriteSchema, type CatalogApp, type Locale, type MadeRestore } from "@hearth/shared";
import { addApp } from "../apps/installs";
import { notFound, Refusal } from "../http/errors";
import type { Template } from "./catalog";
import { asSdkManifest } from "./manifest";
import { FetchError } from "@hearth/sdk/server";
import { z } from "zod";
import { fetchFor, type Outbound } from "../apps/fetch";
import type { Hono } from "hono";
import type { Registry } from "../apps/registry";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import {
  addMadeRow,
  createMadeApp,
  listMadeRows,
  madeFromTemplate,
  madeAppForFrame,
  removeMadeRow,
  replaceMadeRows,
  restoreMadeVersion,
  updateMadeRow,
  type MadeRequest,
} from "./apps";
import { listSpacesForUser } from "../db/people";
import { frameDocument, THEMES, type FramePeople, type FrameTheme } from "./frame";

const BASE = "/api/spaces/:spaceId/apps/:appId";

const replaceSchema = z.strictObject({
  where: z.record(z.string(), z.unknown()).default({}),
  rows: z.array(z.record(z.string(), z.unknown())),
});
const fetchSchema = z.strictObject({
  url: z.string().max(2000),
  headers: z.record(z.string(), z.string()).default({}),
});

/** How long the server waits for an app's fetch at most, its turn in the pace included. */
const FETCH_LIMIT_MS = 60_000;

export function registerMadeRoutes(
  app: Hono<Env>,
  deps: { db: Db; registry: Registry; requireMember: RequireMember; outbound: Outbound; catalog: readonly Template[] },
): void {
  const { db, registry, requireMember, outbound, catalog } = deps;

  // The apps shipped with Hearth, for the Apps page's Add dialog.
  app.get("/api/catalog", requireMember, (c) => {
    const apps: CatalogApp[] = catalog.map((template) => {
      const manifest = asSdkManifest(template.id, template.manifest);
      return {
        id: template.id,
        name: manifest.name,
        description: manifest.description,
        icon: manifest.icon,
        color: manifest.color,
        network: [...(manifest.network ?? [])],
      };
    });
    return c.json(apps);
  });

  // Adds a built-in app to a space as a made app of its own, or brings back
  // the one the space removed, with its data, as adding any app does.
  app.post("/api/spaces/:spaceId/catalog/:templateId", requireMember, async (c) => {
    const { memberAccess } = await readBody(c, addFromCatalogRequestSchema);
    const userId = c.get("user").id;
    const spaceId = c.req.param("spaceId");
    const template = catalog.find((candidate) => candidate.id === c.req.param("templateId"));
    if (!template) throw notFound();
    const existing = madeFromTemplate(db, spaceId, template.id);
    if (existing.some((made) => !made.removed)) {
      throw new Refusal(409, "conflict", "This space has this app already.");
    }
    const removed = existing.find((made) => made.removed);
    if (removed) {
      addApp(db, registry, { userId, spaceId, appId: removed.appId, ...(memberAccess ? { memberAccess } : {}) });
      return c.json({ appId: removed.appId, restored: true });
    }
    const { appId } = createMadeApp(db, registry, {
      userId,
      spaceId,
      manifest: template.manifest,
      html: template.html,
      template: template.id,
      ...(memberAccess ? { memberAccess } : {}),
    });
    return c.json({ appId, restored: false }, 201);
  });
  const requestOf = (c: { get(key: "user"): { id: string }; req: { param(name: string): string } }): MadeRequest => ({
    userId: c.get("user").id,
    spaceId: c.req.param("spaceId"),
    appId: c.req.param("appId"),
    by: "person",
  });

  // The page, for an iframe with sandbox="allow-scripts allow-forms". The theme and the
  // language come from the page around it, which knows what the person sees.
  app.get(`${BASE}/frame`, requireMember, (c) => {
    const found = madeAppForFrame(db, registry, requestOf(c));
    const theme = (THEMES as readonly string[]).includes(c.req.query("theme") ?? "")
      ? (c.req.query("theme") as FrameTheme)
      : "light";
    const locale: Locale = c.req.query("locale") === "zh" ? "zh" : c.get("user").locale;
    const view = c.req.query("view") === "page" ? "page" : "card";
    const user = c.get("user");
    const space = listSpacesForUser(db, user.id).find((candidate) => candidate.id === c.req.param("spaceId"));
    const people: FramePeople = {
      user: { id: user.id, name: user.name },
      space: {
        kind: space?.kind ?? "personal",
        name: space?.name ?? "",
        members: (space?.members ?? []).map(({ id, name }) => ({ id, name })),
      },
    };
    c.set("sandboxed", true);
    return c.html(frameDocument(found, { theme, locale, access: found.level, view, people }));
  });

  app.get(`${BASE}/rows/:collection`, requireMember, (c) => {
    const limit = c.req.query("limit");
    const rows = listMadeRows(db, registry, requestOf(c), c.req.param("collection"), {
      orderBy: c.req.query("orderBy") || undefined,
      desc: c.req.query("desc") === "true",
      limit: limit === undefined || !/^\d{1,5}$/.test(limit) ? undefined : Number(limit),
    });
    return c.json({ rows });
  });

  app.post(`${BASE}/rows/:collection`, requireMember, async (c) => {
    const { data } = await readBody(c, madeRowWriteSchema);
    return c.json({ row: addMadeRow(db, registry, requestOf(c), c.req.param("collection"), data) }, 201);
  });

  app.patch(`${BASE}/rows/:collection/:rowId`, requireMember, async (c) => {
    const { data } = await readBody(c, madeRowWriteSchema);
    const row = updateMadeRow(db, registry, requestOf(c), c.req.param("collection"), c.req.param("rowId"), data);
    return c.json({ row });
  });

  // Many rows at once, all or nothing: a refresh of fetched lists.
  app.post(`${BASE}/rows/:collection/replace`, requireMember, async (c) => {
    const { where, rows } = await readBody(c, replaceSchema);
    return c.json(replaceMadeRows(db, registry, requestOf(c), c.req.param("collection"), where, rows));
  });

  // A GET from one of the hosts the app names, by the server, under the rules
  // of a job's ctx.fetch (src/apps/fetch.ts): no cookie, no sign-in, paced.
  // Whoever may see the app may ask; the answer is the fetched page's alone.
  app.post(`${BASE}/fetch`, requireMember, async (c) => {
    const { url, headers } = await readBody(c, fetchSchema);
    const found = madeAppForFrame(db, registry, requestOf(c));
    const hosts = found.manifest.network ?? [];
    const stop = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(FETCH_LIMIT_MS)]);
    try {
      const answer = await fetchFor(outbound, { hosts, signal: stop })(url, { headers });
      return c.json({ ok: answer.ok, status: answer.status, url: answer.url, headers: answer.headers, text: answer.text });
    } catch (error) {
      if (error instanceof FetchError) return c.json({ error: { code: error.code, message: error.message } }, 502);
      throw error;
    }
  });

  // The person's own undo, from the chat: the app back at an earlier version.
  app.post(`${BASE}/versions/:version/restore`, requireMember, (c) => {
    const version = Number(c.req.param("version"));
    if (!Number.isSafeInteger(version) || version < 1) return c.json({ error: { code: "not_found", message: "There is nothing at this address." } }, 404);
    const restored = restoreMadeVersion(db, registry, { ...requestOf(c), version });
    return c.json({ version: restored.version, previous: restored.previous, restored: restored.restored } satisfies MadeRestore);
  });

  app.delete(`${BASE}/rows/:collection/:rowId`, requireMember, (c) => {
    removeMadeRow(db, registry, requestOf(c), c.req.param("collection"), c.req.param("rowId"));
    return c.body(null, 204);
  });
}
