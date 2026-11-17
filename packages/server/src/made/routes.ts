/**
 * The routes of apps made in Hearth (docs/platform.md): the page the
 * sandbox shows, and the rows its bridge reads and writes through the page
 * around it. Who may do what is decided as for every app, by VISIBLE.
 */
import { madeRowWriteSchema, type Locale } from "@hearth/shared";
import type { Hono } from "hono";
import type { Registry } from "../apps/registry";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import {
  addMadeRow,
  listMadeRows,
  madeAppForFrame,
  removeMadeRow,
  updateMadeRow,
  type MadeRequest,
} from "./apps";
import { frameDocument, THEMES, type FrameTheme } from "./frame";

const BASE = "/api/spaces/:spaceId/apps/:appId";

export function registerMadeRoutes(
  app: Hono<Env>,
  deps: { db: Db; registry: Registry; requireMember: RequireMember },
): void {
  const { db, registry, requireMember } = deps;
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
    c.set("sandboxed", true);
    return c.html(frameDocument(found, { theme, locale }));
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

  app.delete(`${BASE}/rows/:collection/:rowId`, requireMember, (c) => {
    removeMadeRow(db, registry, requestOf(c), c.req.param("collection"), c.req.param("rowId"));
    return c.body(null, 204);
  });
}
