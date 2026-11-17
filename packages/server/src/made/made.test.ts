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
import { processClock, standInResponse, type Outbound, type TransportRequest } from "../apps/fetch";
import { changeMadeApp, createMadeApp, restoreMadeVersion, withMadeApps } from "./apps";
import { loadCatalog } from "./catalog";
import { SANDBOX_CONTENT_SECURITY_POLICY } from "./frame";
import { moveLegacyInstalls } from "./legacy";
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
    expect(SANDBOX_CONTENT_SECURITY_POLICY).toMatch(/sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox$/);
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
    expect(migrate(db).map((migration) => migration.id)).toEqual([6, 7]);
    expect(db.prepare("SELECT app_id AS appId, version, html, created_by AS by FROM made_app_versions").all()).toEqual([
      { appId: "m-aaaaaaaaaa", version: 3, html: "<p>x</p>", by: sam.id },
    ]);
  });
});

describe("what the platform offers a made app's page", () => {
  const FEED = madeManifestSchema.parse({
    name: { en: "Feed", zh: "订阅" },
    collections: { posts: { fields: { title: { type: "text", required: true }, tags: { type: "list" }, set: { type: "text" } } } },
    network: ["api.example.com"],
    settings: {
      topics: { type: "list", scope: "space", default: [], maxItems: 5, maxLength: 20, label: { en: "Topics", zh: "主题" } },
      compact: { type: "switch", scope: "user", default: false, label: "Compact" },
    },
  });

  function feed() {
    const asked: TransportRequest[] = [];
    const outbound: Outbound = {
      transport: async (request) => {
        asked.push(request);
        return standInResponse({ body: { items: [{ id: 1 }] } });
      },
      pace: null,
      clock: processClock,
    };
    const people = family();
    const { app } = testApp({ db: people.db, outbound });
    const registry = withMadeApps(people.db, createRegistry([]));
    const appId = createMadeApp(people.db, registry, { userId: people.sam.id, spaceId: "family", manifest: FEED, html: HTML }).appId;
    const base = `/api/spaces/family/apps/${appId}`;
    const call = (email: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      app.request(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: as(email, body === undefined ? {} : { "Content-Type": "application/json" }),
      });
    return { ...people, appId, asked, call };
  }

  it("tells its page where it is drawn, who is looking and who is in the space", async () => {
    const { sam, lin, call } = feed();
    const html = await (await call(SAM, "/frame?view=page&locale=zh")).text();
    const attribute = /data-info="([^"]*)"/.exec(html)?.[1] ?? "";
    const info: unknown = JSON.parse(attribute.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    expect(info).toMatchObject({
      view: "page",
      locale: "zh",
      access: "edit",
      user: { id: sam.id },
      space: { kind: "group", name: "Family", members: expect.arrayContaining([{ id: lin.id, name: expect.any(String) }]) },
    });
  });

  it("keeps lists of words in a row, and replaces a set of rows at once, all or nothing", async () => {
    const { call } = feed();
    expect((await call(SAM, "/rows/posts", { data: { title: "Old", tags: ["a"], set: "x" } })).status).toBe(201);
    expect((await call(SAM, "/rows/posts", { data: { title: "Kept", set: "y" } })).status).toBe(201);
    expect((await call(SAM, "/rows/posts", { data: { title: "Bad", tags: "a" } })).status).toBe(400);

    const replaced = await call(SAM, "/rows/posts/replace", { where: { set: "x" }, rows: [{ title: "New 1", set: "x", tags: [] }, { title: "New 2", set: "x" }] });
    expect(await replaced.json()).toEqual({ removed: 1, added: 2 });
    // One row that does not fit, and nothing changes.
    expect((await call(SAM, "/rows/posts/replace", { where: { set: "x" }, rows: [{ title: "New 3", set: "x" }, { set: "x" }] })).status).toBe(400);
    const titles = ((await (await call(SAM, "/rows/posts")).json()) as { rows: { title: string }[] }).rows.map((row) => row.title);
    expect(titles.sort()).toEqual(["Kept", "New 1", "New 2"]);
  });

  it("has settings like any app's, in both languages, checked against what it declares", async () => {
    const { db, sam, lin, appId, call } = feed();
    grant(db, "family", appId, lin.id, "view", sam.id);
    expect(await (await call(SAM, "/settings", { space: { topics: ["rust"] } }, "PATCH")).json()).toEqual({ space: { topics: ["rust"] }, user: { compact: false } });
    expect((await call(SAM, "/settings", { space: { topics: ["x".repeat(21)] } }, "PATCH")).status).toBe(400);
    // Lin, who may only look, keeps her own switch and cannot change the space's.
    expect(await (await call(LIN, "/settings", { user: { compact: true } }, "PATCH")).json()).toEqual({ space: { topics: ["rust"] }, user: { compact: true } });
    expect((await call(LIN, "/settings", { space: { topics: [] } }, "PATCH")).status).toBe(403);
  });

  it("fetches through the server, from the hosts it names alone, for whoever may see it", async () => {
    const { db, sam, lin, appId, asked, call } = feed();
    const answer = await call(SAM, "/fetch", { url: "https://api.example.com/search?q=hearth", headers: { accept: "application/json" } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true, status: 200, text: JSON.stringify({ items: [{ id: 1 }] }) });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ url: "https://api.example.com/search?q=hearth", headers: { accept: "application/json", "user-agent": "Hearth" } });
    expect(asked[0]!.headers).not.toHaveProperty("cookie");

    const elsewhere = await call(SAM, "/fetch", { url: "https://example.com/" });
    expect(elsewhere.status).toBe(502);
    expect(((await elsewhere.json()) as { error: { code: string } }).error.code).toBe("refused");
    expect((await call(LIN, "/fetch", { url: "https://api.example.com/" })).status).toBe(404);
    grant(db, "family", appId, lin.id, "view", sam.id);
    expect((await call(LIN, "/fetch", { url: "https://api.example.com/" })).status).toBe(200);
    expect(asked).toHaveLength(2);
  });
});

describe("the built-in apps", () => {
  const catalog = loadCatalog();
  const AT = "2026-01-05T00:00:00.000Z";

  /** The family's grocery list as the build's app kept it: a row, settings, Lin's access and pin, its job. */
  function withOldGrocery() {
    const people = world();
    const { db, sam, lin } = people;
    db.transaction(() => {
      db.prepare("INSERT INTO space_apps (space_id, app_id, member_access, created_by, created_at) VALUES ('family', 'grocery', 'view', ?, ?)").run(sam.id, AT);
      db.prepare("INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at) VALUES ('r-milk', 'family', 'grocery', 'items', ?, ?, ?, ?, ?)")
        .run(JSON.stringify({ name: "Milk", aisle: "Dairy", done: false }), lin.id, lin.id, AT, AT);
      const setting = db.prepare("INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at) VALUES ('family', 'grocery', ?, ?, ?, ?, ?)");
      setting.run(null, JSON.stringify({ aisles: ["Dairy", "Fruit"] }), sam.id, sam.id, AT);
      setting.run(lin.id, JSON.stringify({ hideDone: true }), lin.id, lin.id, AT);
      db.prepare("INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at) VALUES ('family', 'grocery', ?, 'edit', ?, ?)").run(lin.id, sam.id, AT);
      db.prepare("INSERT INTO app_prefs (space_id, app_id, user_id, enabled, pinned) VALUES ('family', 'grocery', ?, 1, 1)").run(lin.id);
      db.prepare("INSERT INTO app_jobs (space_id, app_id, job, next_run_at) VALUES ('family', 'grocery', 'refresh', ?)").run(AT);
    })();
    return people;
  }

  it("are valid made apps with names in both languages", () => {
    expect(catalog.map((template) => template.id)).toEqual(["grocery", "ideas", "trending"]);
    for (const template of catalog) expect(template.manifest.name, template.id).toEqual({ en: expect.any(String), zh: expect.any(String) });
  });

  it("take each install of the build's app of the same name, in place, its rows, settings, access and pins kept", async () => {
    const { db, call } = withOldGrocery();
    const registry = withMadeApps(db, createRegistry([]));
    const { moved, failed } = moveLegacyInstalls(db, registry, catalog);
    expect(failed).toEqual([]);
    expect(moved).toEqual([{ spaceId: "family", from: "grocery", to: expect.stringMatching(/^m-[a-z0-9]{10}$/) }]);
    const base = `/api/spaces/family/apps/${moved[0]!.to}`;

    const rows = (await (await call(LIN, `${base}/rows/items`)).json()) as { rows: unknown[] };
    expect(rows.rows).toEqual([expect.objectContaining({ id: "r-milk", name: "Milk", aisle: "Dairy", done: false })]);
    expect(await (await call(LIN, `${base}/settings`)).json()).toEqual({ space: { aisles: ["Dairy", "Fruit"] }, user: { hideDone: true } });
    // Lin may still change the list, as she could before.
    expect((await call(LIN, `${base}/rows/items`, { method: "POST", body: JSON.stringify({ data: { name: "Eggs", aisle: "Dairy", done: false } }) })).status).toBe(201);
    const session = (await (await call(LIN, "/api/session")).json()) as { apps: Record<string, unknown>[] };
    expect(session.apps.find((app) => app.id === moved[0]!.to)).toMatchObject({ made: true, template: "grocery", pinned: true, name: { en: "Grocery list", zh: "购物清单" } });

    expect(db.prepare("SELECT count(*) AS n FROM space_apps WHERE app_id = 'grocery'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM app_jobs").get()).toEqual({ n: 0 });
    expect(moveLegacyInstalls(db, registry, catalog)).toEqual({ moved: [], failed: [] });
  });

  it("leave an install that holds a row the built-in app would not take as it was, and say why", () => {
    const { db } = withOldGrocery();
    db.prepare("UPDATE app_rows SET data = ? WHERE id = 'r-milk'").run(JSON.stringify({ name: "Milk", aisle: "Dairy", done: false, note: "2%" }));
    const { moved, failed } = moveLegacyInstalls(db, withMadeApps(db, createRegistry([])), catalog);
    expect(moved).toEqual([]);
    expect(failed).toEqual([{ spaceId: "family", from: "grocery", reason: expect.stringMatching(/1 row\(s\) of "grocery" do not fit .*note/) }]);
    expect(db.prepare("SELECT app_id AS appId FROM space_apps").all()).toEqual([{ appId: "grocery" }]);
    expect(db.prepare("SELECT count(*) AS n FROM app_rows WHERE app_id = 'grocery'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM app_jobs WHERE app_id = 'grocery'").get()).toEqual({ n: 1 });
    expect(madeRows(db)).toBe(0);
  });

  it("are added from the Apps page as made apps of their own, once per space, and a removed one comes back with its data", async () => {
    const { db, call } = world();
    const listed = (await (await call(LIN, "/api/catalog")).json()) as { id: string; network: string[] }[];
    expect(listed.map((app) => [app.id, app.network])).toEqual([["grocery", []], ["ideas", []], ["trending", ["api.github.com"]]]);

    expect((await call(LIN, "/api/spaces/family/catalog/ideas", { method: "POST", body: "{}" })).status).toBe(403);
    const added = await call(SAM, "/api/spaces/family/catalog/ideas", { method: "POST", body: JSON.stringify({ memberAccess: "edit" }) });
    expect(added.status).toBe(201);
    const { appId } = (await added.json()) as { appId: string };
    expect((await call(LIN, `/api/spaces/family/apps/${appId}/rows/ideas`, { method: "POST", body: JSON.stringify({ data: { text: "Hi #idea", tags: ["idea"] } }) })).status).toBe(201);
    expect((await call(SAM, "/api/spaces/family/catalog/ideas", { method: "POST", body: "{}" })).status).toBe(409);
    expect((await call(SAM, "/api/spaces/family/catalog/nothing", { method: "POST", body: "{}" })).status).toBe(404);

    expect((await call(SAM, `/api/spaces/family/apps/${appId}`, { method: "DELETE" })).status).toBe(204);
    const back = await call(SAM, "/api/spaces/family/catalog/ideas", { method: "POST", body: JSON.stringify({ memberAccess: "view" }) });
    expect(await back.json()).toEqual({ appId, restored: true });
    const rows = (await (await call(LIN, `/api/spaces/family/apps/${appId}/rows/ideas`)).json()) as { rows: { text: string }[] };
    expect(rows.rows.map((row) => row.text)).toEqual(["Hi #idea"]);
    expect(madeRows(db)).toBe(1);
  });
});

