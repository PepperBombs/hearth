/**
 * Apps made in Hearth (docs/platform.md): who reaches one and its rows, what
 * a row must be, and the headers its page is served with. The risks are
 * one person reaching another's data, and a page that could load or send
 * something; the rest is glue.
 */
import { describe, expect, it } from "vitest";
import { createRegistry } from "../apps/registry";
import { family, grant, LIN, SAM } from "../apps/test-world";
import { migrate, openDatabase, type Db } from "../db/database";
import { MIGRATIONS } from "../db/migrations";
import { createUserWithPersonalSpace } from "../db/people";
import { CONTENT_SECURITY_POLICY } from "../http/security";
import { as, testApp } from "../testing";
import { changeMadeApp, createMadeApp, restoreMadeVersion, withMadeApps } from "./apps";
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

describe("changing an app made in Hearth", () => {
  const withCategory = (required: boolean) =>
    madeManifestSchema.parse({
      ...MANIFEST,
      collections: {
        expenses: {
          fields: { ...MANIFEST.collections.expenses!.fields, category: { type: "choice", options: ["food", "travel"], required } },
        },
      },
    });

  function changing() {
    const people = world();
    const appId = people.make(people.sam.id, people.samsSpace);
    const registry = withMadeApps(people.db, createRegistry([]));
    const as = (userId: string, spaceId = people.samsSpace) => ({ userId, spaceId, appId, by: "person" as const });
    const rows = `/api/spaces/${people.samsSpace}/apps/${appId}/rows/expenses`;
    const add = (data: Record<string, unknown>) =>
      people.call(SAM, rows, { method: "POST", body: JSON.stringify({ data }) });
    const versions = () =>
      (people.db.prepare("SELECT version, note FROM made_app_versions WHERE app_id = ? ORDER BY version").all(appId) as { version: number; note: string }[]);
    return { ...people, appId, registry, as, rows, add, versions };
  }

  it("keeps each change as a version, and refuses one that a stored row would not fit", async () => {
    const { db, sam, samsSpace, appId, registry, as, rows, add, versions, call } = changing();
    expect((await add({ item: "Lunch", amount: 35 })).status).toBe(201);

    // A field no row has yet, optional: every stored row still fits.
    const changed = changeMadeApp(db, registry, { ...as(sam.id), manifest: withCategory(false), note: "Added a category" });
    expect(changed).toEqual({ version: 2, previous: 1, name: "Ledger" });
    expect(versions()).toEqual([{ version: 1, note: "" }, { version: 2, note: "Added a category" }]);
    expect(((await (await call(SAM, rows)).json()) as { rows: unknown[] }).rows).toHaveLength(1);
    const session = (await (await call(SAM, "/api/session")).json()) as { apps: { id: string; version?: number }[] };
    expect(session.apps.find((app) => app.id === appId)?.version).toBe(2);

    for (const [manifest, reason] of [
      [withCategory(true), /1 stored row would no longer fit the app \(expenses row \S+: category/],
      [madeManifestSchema.parse({ ...MANIFEST, collections: { expenses: { fields: { item: { type: "text" }, amount: { type: "text" } } } } }), /amount/],
      [madeManifestSchema.parse({ ...MANIFEST, collections: { trips: { fields: { place: { type: "text" } } } } }), /its collection would be gone/],
    ] as const) {
      expect(() => changeMadeApp(db, registry, { ...as(sam.id), manifest, note: "x" })).toThrow(reason);
    }
    expect(() => changeMadeApp(db, registry, { ...as(sam.id), manifest: withCategory(false), note: "x" })).toThrow(/change nothing/);
    expect(versions()).toHaveLength(2);
    expect(samsSpace).toBeTruthy();
  });

  it("goes back to an earlier version as a new one, unless a row written since would not fit it", async () => {
    const { db, sam, lin, samsSpace, appId, registry, as, add, versions, call } = changing();
    changeMadeApp(db, registry, { ...as(sam.id), manifest: withCategory(false), note: "Added a category" });
    changeMadeApp(db, registry, { ...as(sam.id), html: "<p>new look</p>", note: "New look" });

    const back = await call(SAM, `/api/spaces/${samsSpace}/apps/${appId}/versions/2/restore`, { method: "POST" });
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ version: 4, previous: 3, restored: 2 });
    expect(versions().at(-1)).toEqual({ version: 4, note: "Back to version 2" });
    const page = await (await call(SAM, `/api/spaces/${samsSpace}/apps/${appId}/frame`)).text();
    expect(page).not.toContain("new look");

    // A row that uses the category: version 1, which has no category, would hide it.
    expect((await add({ item: "Tea", amount: 4, category: "food" })).status).toBe(201);
    expect(() => restoreMadeVersion(db, registry, { ...as(sam.id), version: 1 })).toThrow(/would no longer fit/);
    expect(() => restoreMadeVersion(db, registry, { ...as(sam.id), version: 4 })).toThrow(/is the one in use/);
    expect((await call(LIN, `/api/spaces/${samsSpace}/apps/${appId}/versions/2/restore`, { method: "POST" })).status).toBe(404);
    expect(lin.id).toBeTruthy();
  });

  it("is changed only by those who may add apps to its space, with edit access to it", () => {
    const { db, sam, lin, kim } = world();
    const registry = withMadeApps(db, createRegistry([]));
    const appId = createMadeApp(db, registry, { userId: sam.id, spaceId: "family", manifest: MANIFEST, html: HTML }).appId;
    grant(db, "family", appId, lin.id, "edit", sam.id);
    grant(db, "family", appId, kim.id, "edit", sam.id);
    const change = (userId: string) =>
      changeMadeApp(db, registry, { userId, spaceId: "family", appId, by: "person", html: `<p>${userId}</p>`, note: "x" });
    // Lin may change its rows, not what it is; Kim may add apps here.
    expect(() => change(lin.id)).toThrow(/for the space's owners and the members they allow/);
    expect(change(kim.id).version).toBe(2);
  });

  it("keeps the version of an app made before versions were kept", () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS.filter((migration) => migration.id <= 5));
    const sam = createUserWithPersonalSpace(db, { email: SAM, locale: "en" });
    const space = (db.prepare("SELECT id FROM spaces WHERE created_by = ?").get(sam.id) as { id: string }).id;
    const at = "2026-11-17T00:00:00.000Z";
    db.transaction(() => {
      db.prepare("INSERT INTO made_apps (app_id, space_id, manifest, html, version, created_by, updated_by, created_at, updated_at) VALUES ('m-aaaaaaaaaa', ?, ?, '<p>x</p>', 3, ?, ?, ?, ?)").run(space, JSON.stringify(MANIFEST), sam.id, sam.id, at, at);
      db.prepare("INSERT INTO space_apps (space_id, app_id, created_by, created_at) VALUES (?, 'm-aaaaaaaaaa', ?, ?)").run(space, sam.id, at);
    })();
    expect(migrate(db).map((migration) => migration.id)).toEqual([6]);
    expect(db.prepare("SELECT app_id AS appId, version, html, created_by AS by FROM made_app_versions").all()).toEqual([
      { appId: "m-aaaaaaaaaa", version: 3, html: "<p>x</p>", by: sam.id },
    ]);
  });
});
