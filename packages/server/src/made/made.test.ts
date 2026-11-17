/**
 * Apps made in Hearth (docs/platform.md): who reaches one and its rows, what
 * a row must be, and the headers its page is served with. The risks are
 * one person reaching another's data, and a page that could load or send
 * something; the rest is glue.
 */
import { describe, expect, it } from "vitest";
import { createRegistry } from "../apps/registry";
import { family, grant, LIN, SAM } from "../apps/test-world";
import type { Db } from "../db/database";
import { CONTENT_SECURITY_POLICY } from "../http/security";
import { as, testApp } from "../testing";
import { createMadeApp, withMadeApps } from "./apps";
import { SANDBOX_CONTENT_SECURITY_POLICY } from "./frame";
import { madeManifestSchema } from "./manifest";

const MANIFEST = madeManifestSchema.parse({
  name: "Ledger",
  icon: "wallet",
  collections: {
    expenses: {
      fields: {
        item: { type: "text", required: true },
        amount: { type: "number", required: true },
        on: { type: "date" },
        kind: { type: "choice", options: ["food", "travel"] },
      },
    },
  },
});
const HTML = "<!doctype html><html><head><title>Ledger</title></head><body><script>/* the app */</script></body></html>";

function world() {
  const people = family();
  const { app } = testApp({ db: people.db });
  const registry = withMadeApps(people.db, createRegistry([]));
  const make = (userId: string, spaceId: string) =>
    createMadeApp(people.db, registry, { userId, spaceId, manifest: MANIFEST, html: HTML }).appId;
  const call = (email: string, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: as(email, init.body ? { "Content-Type": "application/json" } : {}) });
  return { ...people, make, call };
}

const madeRows = (db: Db) => (db.prepare("SELECT count(*) AS n FROM made_apps").get() as { n: number }).n;

describe("an app made in Hearth", () => {
  it("is an install of its space: in its maker's session, marked as made, and in no one else's", async () => {
    const { sam, samsSpace, make, call } = world();
    const appId = make(sam.id, samsSpace);
    expect(appId).toMatch(/^m-[a-z0-9]{10}$/);

    const mine = (await (await call(SAM, "/api/session")).json()) as { apps: { id: string; made?: boolean }[] };
    expect(mine.apps).toContainEqual(
      expect.objectContaining({ id: appId, spaceId: samsSpace, made: true, name: { en: "Ledger", zh: "Ledger" } }),
    );
    const lins = (await (await call(LIN, "/api/session")).json()) as { apps: { id: string }[] };
    expect(lins.apps.map((app) => app.id)).not.toContain(appId);
  });

  it("is made only by those who may add apps to the space, and leaves nothing behind when refused", () => {
    const { db, lin, make } = world();
    expect(() => make(lin.id, "family")).toThrow(/for its owners and the members they allow/);
    expect(madeRows(db)).toBe(0);
  });

  it("keeps rows that fit its fields, and refuses the others with the reason", async () => {
    const { sam, samsSpace, make, call } = world();
    const appId = make(sam.id, samsSpace);
    const rows = `/api/spaces/${samsSpace}/apps/${appId}/rows/expenses`;

    const added = await call(SAM, rows, { method: "POST", body: JSON.stringify({ data: { item: "Lunch", amount: 35, on: "2026-11-17" } }) });
    expect(added.status).toBe(201);
    const { row } = (await added.json()) as { row: { id: string; item: string; createdBy: string } };
    expect(row).toMatchObject({ item: "Lunch", createdBy: sam.id });

    const changed = await call(SAM, `${rows}/${row.id}`, { method: "PATCH", body: JSON.stringify({ data: { amount: 36 } }) });
    expect(((await changed.json()) as { row: { amount: number } }).row.amount).toBe(36);

    const listed = (await (await call(SAM, `${rows}?orderBy=amount&desc=true`)).json()) as { rows: unknown[] };
    expect(listed.rows).toEqual([expect.objectContaining({ id: row.id, item: "Lunch", amount: 36 })]);

    for (const [data, reason] of [
      [{ item: "Taxi" }, /amount/],
      [{ item: "Taxi", amount: "20" }, /amount/],
      [{ item: "Taxi", amount: 20, tip: 2 }, /tip/],
      [{ item: "Taxi", amount: 20, kind: "fun" }, /kind/],
      [{ item: "Taxi", amount: 20, on: "yesterday" }, /on/],
    ] as const) {
      const refused = await call(SAM, rows, { method: "POST", body: JSON.stringify({ data }) });
      expect(refused.status, JSON.stringify(data)).toBe(400);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(reason);
    }
    expect((await call(SAM, `/api/spaces/${samsSpace}/apps/${appId}/rows/trips`)).status).toBe(404);

    expect((await call(SAM, `${rows}/${row.id}`, { method: "DELETE" })).status).toBe(204);
    expect(((await (await call(SAM, rows)).json()) as { rows: unknown[] }).rows).toEqual([]);
  });

  it("is out of reach of everyone outside its space, page and rows alike, and of members it is not shared with", async () => {
    const { db, sam, lin, samsSpace, make, call } = world();
    const personal = make(sam.id, samsSpace);
    for (const path of [`/api/spaces/${samsSpace}/apps/${personal}/frame`, `/api/spaces/${samsSpace}/apps/${personal}/rows/expenses`]) {
      expect((await call(LIN, path)).status, path).toBe(404);
    }
    // Asked for through a space of Lin's own, the app is not there either.
    expect((await call(LIN, `/api/spaces/family/apps/${personal}/rows/expenses`)).status).toBe(404);

    const shared = make(sam.id, "family");
    const rows = `/api/spaces/family/apps/${shared}/rows/expenses`;
    expect((await call(LIN, rows)).status).toBe(404);
    grant(db, "family", shared, lin.id, "view", sam.id);
    expect((await call(LIN, rows)).status).toBe(200);
    const write = await call(LIN, rows, { method: "POST", body: JSON.stringify({ data: { item: "Tea", amount: 4 } }) });
    expect(write.status).toBe(403);
  });

  it("serves its page with the sandbox's policy, and Hearth's own pages keep theirs", async () => {
    const { sam, samsSpace, make, call } = world();
    const appId = make(sam.id, samsSpace);
    const page = await call(SAM, `/api/spaces/${samsSpace}/apps/${appId}/frame?theme=dark`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(SANDBOX_CONTENT_SECURITY_POLICY);
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toMatch(/default-src 'none'/);
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toMatch(/sandbox allow-scripts allow-forms$/);
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toMatch(/form-action 'none'/);
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const html = await page.text();
    // The bridge is in place before the app's own script runs, and the theme is the one asked for.
    expect(html.indexOf("window.hearth = Object.freeze")).toBeGreaterThan(0);
    expect(html.indexOf("window.hearth = Object.freeze")).toBeLessThan(html.indexOf("/* the app */"));
    expect(html).toContain("color-scheme:dark");

    const session = await call(SAM, "/api/session");
    expect(session.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(session.headers.get("x-frame-options")).toBe("DENY");
  });
});
