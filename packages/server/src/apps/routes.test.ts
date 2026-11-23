/**
 * Adding an app to a space, removing it, bringing it back and deleting its
 * data, through the routes and as the session shows it
 * (docs/mini-app-contract.md, sections A6 and A8). Every app is made in
 * Hearth (docs/platform.md): a person adds one from the built-in apps
 * (POST /api/spaces/:spaceId/catalog/:templateId), or a test makes one in
 * a space directly (`makeApp`); the app's route (PUT .../apps/:appId)
 * brings a removed one back.
 */
import {
  apiErrorSchema,
  appSummarySchema,
  sessionSchema,
  type ApiErrorCode,
  type AppSummary,
} from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/database";
import { loadCatalog } from "../made/catalog";
import { as, testApp } from "../testing";
import { count, family, grant, install, JOURNAL, KIM, LIN, makeApp, NOA, NOW, SAM, setPrefs, unreadable } from "./test-world";

const BASE = "http://hearth.example.com";
/** Sam's own checklist, in his personal space. */
const OWN = "m-samslist00";
/** The family's checklist. */
const OURS = "m-ourlist000";
/** Lin's own checklist. */
const LINS = "m-linslist00";
/** Sam's journal. */
const DIARY = "m-samsdiary0";

const GROCERY = loadCatalog().find((template) => template.id === "grocery")!;

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

beforeEach(() => {
  world = family();
  ({ app, errors } = testApp({ db: world.db }));
});

function call(who: string | null, method: string, path: string, body?: unknown, on = app) {
  const headers: Record<string, string> = who ? as(who) : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  return on.request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Adds a built-in app to a space, as the Apps page does, and gives its new ID. */
async function addBuiltIn(who: string, spaceId: string, templateId = "grocery", body: unknown = {}): Promise<string> {
  const response = await call(who, "POST", `/api/spaces/${spaceId}/catalog/${templateId}`, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { appId: string }).appId;
}
const addFromCatalog = (who: string, spaceId: string, templateId = "grocery", body: unknown = {}) =>
  call(who, "POST", `/api/spaces/${spaceId}/catalog/${templateId}`, body);
const add = (who: string, spaceId: string, appId: string, body: unknown = {}) =>
  call(who, "PUT", `/api/spaces/${spaceId}/apps/${appId}`, body);
const remove = (who: string, spaceId: string, appId: string) =>
  call(who, "DELETE", `/api/spaces/${spaceId}/apps/${appId}`);
const deleteData = (who: string, spaceId: string, appId: string, body: unknown = { confirm: appId }) =>
  call(who, "DELETE", `/api/spaces/${spaceId}/apps/${appId}/data`, body);

/** Who asks about which app in which space; made when the test runs, once the world exists. */
const at = (request: () => [who: string, spaceId: string, appId: string]) => request;

async function expectDone(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

async function appsOf(who: string, on = app): Promise<AppSummary[]> {
  const response = await call(who, "GET", "/api/session", undefined, on);
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json()).apps;
}

/** What a person's session lists, as "space/app: access". */
async function seenBy(who: string, on = app): Promise<string[]> {
  return (await appsOf(who, on)).map((entry) => `${entry.spaceId}/${entry.id}: ${entry.access}`);
}

const installs = (db: Db) =>
  db
    .prepare(
      `SELECT space_id AS spaceId, app_id AS appId, member_access AS memberAccess,
              created_by AS createdBy, removed_at AS removedAt
         FROM space_apps ORDER BY space_id, app_id`,
    )
    .all();

function addRow(spaceId: string, appId: string, id: string, by: string, name: string): void {
  world.db
    .prepare(
      `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'items', ?, ?, ?, ?, ?)`,
    )
    .run(id, spaceId, appId, JSON.stringify({ name, done: false }), by, by, NOW, NOW);
}

/** Settings values: the space's when `userId` is null, else that person's own. */
function addSettings(spaceId: string, appId: string, userId: string | null, by: string, data: unknown): void {
  world.db
    .prepare(
      `INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(spaceId, appId, userId, JSON.stringify(data), by, by, NOW);
}

/** Everything the app holds in the space, to compare before and after. */
function dataOf(spaceId: string, appId: string) {
  return {
    rows: world.db
      .prepare("SELECT * FROM app_rows WHERE space_id = ? AND app_id = ? ORDER BY id")
      .all(spaceId, appId),
    settings: world.db
      .prepare("SELECT * FROM app_settings WHERE space_id = ? AND app_id = ? ORDER BY user_id")
      .all(spaceId, appId),
    prefs: world.db
      .prepare("SELECT * FROM app_prefs WHERE space_id = ? AND app_id = ? ORDER BY user_id")
      .all(spaceId, appId),
  };
}

describe("adding an app to a personal space", () => {
  it("puts it in the session, described from its manifest", async () => {
    expect(await appsOf(SAM)).toEqual([]);
    const appId = await addBuiltIn(SAM, world.samsSpace);

    const response = await call(SAM, "GET", "/api/session");
    const body = (await response.json()) as { apps: unknown[] };
    // Strict, so that a field the contract does not name would fail too.
    expect(appSummarySchema.strict().array().parse(body.apps)).toEqual([
      {
        id: appId,
        spaceId: world.samsSpace,
        name: { en: "Grocery list", zh: "购物清单" },
        description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
        icon: "shopping-bag",
        color: "green",
        widgetSize: "tall",
        access: "edit",
        enabled: true,
        pinned: false,
        hasPage: true,
        made: true,
        version: 1,
        template: "grocery",
        settings: GROCERY.manifest.settings,
      },
    ]);
    expect(installs(world.db)).toEqual([
      {
        spaceId: world.samsSpace,
        appId,
        memberAccess: "none",
        createdBy: world.sam.id,
        removedAt: null,
      },
    ]);
  });

  it("shows it to nobody else", async () => {
    await addBuiltIn(SAM, world.samsSpace);
    expect(await appsOf(LIN)).toEqual([]);
    expect(await appsOf(KIM)).toEqual([]);
  });

  it("lists each app once for the space it is in", async () => {
    const grocery = await addBuiltIn(SAM, world.samsSpace);
    const ideas = await addBuiltIn(SAM, world.samsSpace, "ideas");
    const ours = await addBuiltIn(SAM, world.family);
    const seen = await seenBy(SAM);
    // Two added in the same moment come in the order of their IDs, which are random.
    expect(seen.slice(0, 2).sort()).toEqual([`${world.samsSpace}/${grocery}: edit`, `${world.samsSpace}/${ideas}: edit`].sort());
    expect(seen.slice(2)).toEqual([`${world.family}/${ours}: edit`]);
    expect(new Set([grocery, ideas, ours]).size).toBe(3);
  });

  it("changes nothing when the app is already there", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    addRow(world.samsSpace, OWN, "row-1", world.sam.id, "Sample item");
    const before = [installs(world.db), dataOf(world.samsSpace, OWN)];
    await expectDone(await add(SAM, world.samsSpace, OWN));
    await expectDone(await add(SAM, world.samsSpace, OWN, { memberAccess: "none" }));
    expect([installs(world.db), dataOf(world.samsSpace, OWN)]).toEqual(before);
  });

  it.each([
    ["an app the server does not hold", at(() => [SAM, world.samsSpace, "nothing"])],
    ["an ID that only looks like an app", at(() => [SAM, world.samsSpace, "constructor"])],
    ["an app of another space, to its own maker", at(() => [SAM, world.samsSpace, OURS])],
    ["someone else's personal space", at(() => [LIN, world.samsSpace, OWN])],
    ["a group the person is not in", at(() => [NOA, world.family, OURS])],
    ["a space that does not exist", at(() => [SAM, "nowhere", OWN])],
  ] as const)("answers 404 for %s and adds nothing", async (_label, request) => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id, { removedAt: NOW });
    makeApp(world.db, world.family, OURS, world.sam.id, { removedAt: NOW });
    const before = installs(world.db);
    const [who, spaceId, appId] = request();
    await expectError(await add(who, spaceId, appId), 404, "not_found");
    expect(installs(world.db)).toEqual(before);
  });

  it.each([
    ["text that is not JSON", "{ memberAccess: view"],
    ["no body at all", undefined],
    ["a list", []],
    ["nothing", null],
    ["a level that does not exist", { memberAccess: "admin" }],
    ["a property the contract does not name", { memberAccess: "view", pinned: true }],
  ])("refuses %s", async (_label, body) => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id, { removedAt: NOW });
    const before = installs(world.db);
    await expectError(await call(SAM, "PUT", `/api/spaces/${world.samsSpace}/apps/${OWN}`, body), 400, "invalid_request");
    await expectError(await call(SAM, "POST", `/api/spaces/${world.samsSpace}/catalog/grocery`, body), 400, "invalid_request");
    expect(installs(world.db)).toEqual(before);
  });

  it("needs sign-in, and is refused from another site", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id, { removedAt: NOW });
    const before = installs(world.db);
    for (const path of [`/api/spaces/${world.samsSpace}/apps/${OWN}`, `/api/spaces/${world.samsSpace}/catalog/grocery`]) {
      const method = path.includes("catalog") ? "POST" : "PUT";
      await expectError(await call(null, method, path, {}), 401, "unauthenticated");
      await expectError(await call("stranger@example.com", method, path, {}), 403, "not_a_member");
      const crossSite = await app.request(`${BASE}${path}`, {
        method,
        headers: as(SAM, { "content-type": "application/json", origin: "https://evil.example.net" }),
        body: "{}",
      });
      await expectError(crossSite, 403, "invalid_request");
    }
    expect(installs(world.db)).toEqual(before);
  });

  it("logs nothing for a request it turns down", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id);
    await add(SAM, world.samsSpace, "nothing");
    await add(LIN, world.family, OURS);
    await addFromCatalog(LIN, world.family);
    await addFromCatalog(SAM, world.samsSpace, "nothing");
    expect(errors).toEqual([]);
  });
});

describe("adding an app to a group", () => {
  it("shows it to the owners alone unless the person adding it says otherwise", async () => {
    const appId = await addBuiltIn(SAM, world.family);
    expect(await seenBy(SAM)).toEqual([`${world.family}/${appId}: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
  });

  it.each(["view", "edit"] as const)("gives every member %s when asked to", async (memberAccess) => {
    const appId = await addBuiltIn(SAM, world.family, "grocery", { memberAccess });
    expect(await seenBy(SAM)).toEqual([`${world.family}/${appId}: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/${appId}: ${memberAccess}`]);
    expect(await seenBy(KIM)).toEqual([`${world.family}/${appId}: ${memberAccess}`]);
    expect(await seenBy(NOA)).toEqual([]);
  });

  it("is refused to a member who may not add apps, whatever the app", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id, { removedAt: NOW });
    const before = installs(world.db);
    await expectError(await addFromCatalog(LIN, world.family), 403, "forbidden");
    await expectError(await add(LIN, world.family, OURS), 403, "forbidden");
    await expectError(await add(LIN, world.family, "nothing"), 403, "forbidden");
    expect(installs(world.db)).toEqual(before);
  });

  it("lets a member who may add apps add one, and gives them edit", async () => {
    const appId = await addBuiltIn(KIM, world.family);
    expect(await seenBy(KIM)).toEqual([`${world.family}/${appId}: edit`]);
    // The owner sees everything in the group; the other member was not offered it.
    expect(await seenBy(SAM)).toEqual([`${world.family}/${appId}: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(installs(world.db)).toMatchObject([{ createdBy: world.kim.id, memberAccess: "none" }]);
    expect(
      world.db.prepare("SELECT user_id AS userId, level, created_by AS createdBy FROM app_access").all(),
    ).toEqual([{ userId: world.kim.id, level: "edit", createdBy: world.kim.id }]);
  });

  it("lets that member choose what the others get", async () => {
    const appId = await addBuiltIn(KIM, world.family, "grocery", { memberAccess: "view" });
    expect(await seenBy(KIM)).toEqual([`${world.family}/${appId}: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/${appId}: view`]);
  });

  it("does not change access when the app is already there", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id, { memberAccess: "view" });
    await expectError(await add(SAM, world.family, OURS, { memberAccess: "edit" }), 409, "conflict");
    await expectError(await add(SAM, world.family, OURS, { memberAccess: "none" }), 409, "conflict");
    await expectDone(await add(SAM, world.family, OURS, { memberAccess: "view" }));
    await expectDone(await add(SAM, world.family, OURS));
    await expectDone(await add(KIM, world.family, OURS));
    expect(await seenBy(LIN)).toEqual([`${world.family}/${OURS}: view`]);
    expect(await seenBy(KIM)).toEqual([`${world.family}/${OURS}: view`]);
    expect(count(world.db, "app_access", world.family, OURS)).toBe(0);
  });

  it("does not let a member add their way into an app they were not given", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id);
    addRow(world.family, OURS, "row-1", world.sam.id, "Sample item");
    await expectError(await add(KIM, world.family, OURS), 409, "conflict");
    await expectError(await add(KIM, world.family, OURS, { memberAccess: "edit" }), 409, "conflict");
    expect(await seenBy(KIM)).toEqual([]);
    expect(count(world.db, "app_access", world.family, OURS)).toBe(0);
    expect(installs(world.db)).toMatchObject([{ memberAccess: "none", createdBy: world.sam.id }]);
  });
});

describe("removing an app", () => {
  it("takes it out of everyone's session and keeps its entry", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id, { memberAccess: "edit" });
    await expectDone(await remove(SAM, world.family, OURS));
    expect(await seenBy(SAM)).toEqual([]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(installs(world.db)).toMatchObject([
      { spaceId: world.family, appId: OURS, removedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    ]);
  });

  it("answers 404 once the app is removed", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    await remove(SAM, world.samsSpace, OWN);
    const removedAt = installs(world.db);
    await expectError(await remove(SAM, world.samsSpace, OWN), 404, "not_found");
    expect(installs(world.db)).toEqual(removedAt);
  });

  it("leaves the space's other apps, and other spaces' apps, alone", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    makeApp(world.db, world.family, OURS, world.sam.id);
    makeApp(world.db, world.family, DIARY, world.sam.id, { manifest: JOURNAL });
    makeApp(world.db, world.linsSpace, LINS, world.lin.id);
    await remove(SAM, world.family, OURS);
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/${OWN}: edit`, `${world.family}/${DIARY}: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.linsSpace}/${LINS}: edit`]);
  });

  it("is for owners: a member who can edit the app gets 403", async () => {
    const appId = await addBuiltIn(KIM, world.family, "grocery", { memberAccess: "edit" });
    await expectError(await remove(LIN, world.family, appId), 403, "forbidden");
    // Not even the member who added it.
    await expectError(await remove(KIM, world.family, appId), 403, "forbidden");
    expect(await seenBy(LIN)).toEqual([`${world.family}/${appId}: edit`]);
    expect(installs(world.db)).toMatchObject([{ removedAt: null }]);
  });

  it.each([
    ["a member the app is hidden from", at(() => [LIN, world.family, OURS])],
    ["someone who is not in the space", at(() => [NOA, world.family, OURS])],
    ["an app the space does not have", at(() => [SAM, world.family, OWN])],
    ["an app the server does not hold", at(() => [SAM, world.family, "nothing"])],
    ["a space that does not exist", at(() => [SAM, "nowhere", OURS])],
  ] as const)("answers 404 for %s", async (_label, request) => {
    makeApp(world.db, world.family, OURS, world.sam.id);
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    const before = installs(world.db);
    const [who, spaceId, appId] = request();
    await expectError(await remove(who, spaceId, appId), 404, "not_found");
    expect(installs(world.db)).toEqual(before);
  });
});

describe("bringing a removed app back", () => {
  it("brings back its data, its settings and each person's switch and pin, untouched", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id, { memberAccess: "edit" });
    addRow(world.family, OURS, "row-1", world.sam.id, "Sample item one");
    addRow(world.family, OURS, "row-2", world.lin.id, "Sample item two");
    addSettings(world.family, OURS, null, world.sam.id, { sections: ["Sample section"] });
    addSettings(world.family, OURS, world.lin.id, world.lin.id, { hideDone: true });
    setPrefs(world.db, world.family, OURS, world.lin.id, { enabled: false, pinned: true });
    const before = dataOf(world.family, OURS);
    expect(before.rows).toHaveLength(2);
    expect(before.settings).toHaveLength(2);
    expect(before.prefs).toHaveLength(1);

    await expectDone(await remove(SAM, world.family, OURS));
    expect(await seenBy(SAM)).toEqual([]);
    expect(dataOf(world.family, OURS)).toEqual(before);

    await expectDone(await add(SAM, world.family, OURS, { memberAccess: "edit" }));
    expect(dataOf(world.family, OURS)).toEqual(before);
    expect(installs(world.db)).toMatchObject([
      { spaceId: world.family, appId: OURS, removedAt: null, createdBy: world.sam.id },
    ]);
    expect(await seenBy(SAM)).toEqual([`${world.family}/${OURS}: edit`]);
    expect(await appsOf(LIN)).toMatchObject([
      { id: OURS, spaceId: world.family, access: "edit", enabled: false, pinned: true },
    ]);
  });

  it("works in a personal space too", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    addRow(world.samsSpace, OWN, "row-1", world.sam.id, "Sample item");
    const before = dataOf(world.samsSpace, OWN);
    await remove(SAM, world.samsSpace, OWN);
    await expectDone(await add(SAM, world.samsSpace, OWN));
    expect(dataOf(world.samsSpace, OWN)).toEqual(before);
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/${OWN}: edit`]);
  });

  it("brings it back in its own space only", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    makeApp(world.db, world.family, OURS, world.sam.id);
    await remove(SAM, world.samsSpace, OWN);
    await remove(SAM, world.family, OURS);
    // An app lives in the space it was made in: it is not there to be brought into another.
    await expectError(await add(SAM, world.family, OWN), 404, "not_found");
    await expectDone(await add(SAM, world.family, OURS, { memberAccess: "view" }));
    expect(await seenBy(SAM)).toEqual([`${world.family}/${OURS}: edit`]);
    // Sam's own space has a random ID, so the two entries come in either order.
    expect(installs(world.db)).toHaveLength(2);
    expect(installs(world.db)).toContainEqual(
      expect.objectContaining({ spaceId: world.family, appId: OURS, memberAccess: "view", removedAt: null }),
    );
    expect(installs(world.db)).toContainEqual(
      expect.objectContaining({ spaceId: world.samsSpace, appId: OWN, memberAccess: "none", removedAt: expect.any(String) }),
    );
  });

  it("starts access afresh: what is asked for now, and no exceptions from before", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id, { memberAccess: "edit" });
    grant(world.db, world.family, OURS, world.kim.id, "edit", world.sam.id);
    await remove(SAM, world.family, OURS);

    // "Only me for now" means that, whoever could use the app before.
    await expectDone(await add(SAM, world.family, OURS));
    expect(await seenBy(SAM)).toEqual([`${world.family}/${OURS}: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
    expect(count(world.db, "app_access", world.family, OURS)).toBe(0);

    await remove(SAM, world.family, OURS);
    await expectDone(await add(SAM, world.family, OURS, { memberAccess: "view" }));
    expect(await seenBy(LIN)).toEqual([`${world.family}/${OURS}: view`]);
  });

  it("is for owners: a member who may add apps cannot bring back data they never saw", async () => {
    makeApp(world.db, world.family, OURS, world.sam.id);
    addRow(world.family, OURS, "row-1", world.sam.id, "Sample item");
    await remove(SAM, world.family, OURS);
    const removed = installs(world.db);

    await expectError(await add(KIM, world.family, OURS), 409, "conflict");
    expect(installs(world.db)).toEqual(removed);
    expect(await seenBy(KIM)).toEqual([]);
    expect(count(world.db, "app_access", world.family, OURS)).toBe(0);
    // Nor one who could use it before it was removed.
    world.db.prepare("UPDATE space_apps SET member_access = 'edit'").run();
    await expectError(await add(KIM, world.family, OURS), 409, "conflict");
    expect(await seenBy(KIM)).toEqual([]);
  });

  it("brings a removed built-in app back through the Apps page as well, and only for an owner", async () => {
    const appId = await addBuiltIn(SAM, world.family);
    addRow(world.family, appId, "row-1", world.sam.id, "Sample item");
    await expectDone(await remove(SAM, world.family, appId));
    await expectError(await addFromCatalog(KIM, world.family), 409, "conflict");
    const back = await addFromCatalog(SAM, world.family, "grocery", { memberAccess: "view" });
    expect(await back.json()).toEqual({ appId, restored: true });
    expect(dataOf(world.family, appId).rows).toHaveLength(1);
    expect(await seenBy(LIN)).toEqual([`${world.family}/${appId}: view`]);
  });
});

describe("an app the server no longer holds", () => {
  it("vanishes from the session, answers 404, keeps its data, and returns once it is held again", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    makeApp(world.db, world.family, OURS, world.sam.id, { memberAccess: "edit" });
    makeApp(world.db, world.samsSpace, DIARY, world.sam.id, { manifest: JOURNAL });
    addRow(world.family, OURS, "row-1", world.sam.id, "Sample item");
    addSettings(world.family, OURS, null, world.sam.id, { sections: ["Sample section"] });
    const before = [installs(world.db), dataOf(world.family, OURS)];

    // A release that cannot read the family's checklist.
    const putBack = unreadable(world.db, OURS);
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/${DIARY}: edit`, `${world.samsSpace}/${OWN}: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    const path = `/api/spaces/${world.family}/apps/${OURS}`;
    await expectError(await call(SAM, "PUT", path, {}), 404, "not_found");
    await expectError(await call(SAM, "DELETE", path), 404, "not_found");
    await expectError(await call(LIN, "DELETE", path), 404, "not_found");
    await expectError(await call(SAM, "GET", `${path}/rows/items`), 404, "not_found");
    expect([installs(world.db), dataOf(world.family, OURS)]).toEqual(before);
    expect(errors).toEqual([]);

    // A release that reads it again.
    putBack();
    expect(await seenBy(SAM)).toEqual([
      `${world.samsSpace}/${DIARY}: edit`,
      `${world.samsSpace}/${OWN}: edit`,
      `${world.family}/${OURS}: edit`,
    ]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/${OURS}: edit`]);
    expect([installs(world.db), dataOf(world.family, OURS)]).toEqual(before);
  });

  it("is what an install of a release before the built-in apps is, if it could not move: hidden, its data kept", async () => {
    install(world.db, world.family, "grocery", world.sam.id, { memberAccess: "edit" });
    addRow(world.family, "grocery", "row-1", world.lin.id, "Sample item");
    const before = [installs(world.db), dataOf(world.family, "grocery")];
    expect(await seenBy(SAM)).toEqual([]);
    expect(await seenBy(LIN)).toEqual([]);
    await expectError(await add(SAM, world.family, "grocery"), 404, "not_found");
    await expectError(await remove(SAM, world.family, "grocery"), 404, "not_found");
    expect([installs(world.db), dataOf(world.family, "grocery")]).toEqual(before);
  });
});

describe("deleting an app's data", () => {
  let ours: string;

  /** The family's grocery list with rows, settings, an exception and a pin; Sam's own checklist beside it. */
  async function filled() {
    ours = await addBuiltIn(SAM, world.family, "grocery", { memberAccess: "view" });
    addRow(world.family, ours, "row-1", world.sam.id, "Sample item one");
    addRow(world.family, ours, "row-2", world.lin.id, "Sample item two");
    addSettings(world.family, ours, null, world.sam.id, { aisles: ["Sample aisle"] });
    addSettings(world.family, ours, world.lin.id, world.lin.id, { hideDone: true });
    grant(world.db, world.family, ours, world.kim.id, "edit", world.sam.id);
    setPrefs(world.db, world.family, ours, world.lin.id, { enabled: true, pinned: true });
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    addRow(world.samsSpace, OWN, "row-3", world.sam.id, "Sample item three");
    addSettings(world.samsSpace, OWN, null, world.sam.id, { sections: [] });
  }

  const left = (spaceId: string, appId: string) =>
    ["space_apps", "app_rows", "app_settings", "app_access", "app_prefs", "made_apps"].map((table) =>
      count(world.db, table, spaceId, appId),
    );

  it("is refused while the app is in the space", async () => {
    await filled();
    await expectError(await deleteData(SAM, world.family, ours), 409, "conflict");
    expect(left(world.family, ours)).toEqual([1, 2, 2, 1, 1, 1]);
  });

  it("deletes everything a removed app had in that space, the app itself included, and nothing else", async () => {
    await filled();
    await remove(SAM, world.family, ours);
    expect(left(world.family, ours)).toEqual([1, 2, 2, 1, 1, 1]);

    await expectDone(await deleteData(SAM, world.family, ours));
    expect(left(world.family, ours)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(world.db.prepare("SELECT count(*) AS n FROM made_app_versions WHERE app_id = ?").get(ours)).toEqual({ n: 0 });
    // Another app in another space is untouched.
    expect(left(world.samsSpace, OWN)).toEqual([1, 1, 1, 0, 0, 1]);
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/${OWN}: edit`]);
    expect(errors).toEqual([]);
  });

  it("leaves other apps in the same space alone", async () => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    makeApp(world.db, world.samsSpace, DIARY, world.sam.id, { manifest: JOURNAL });
    addRow(world.samsSpace, OWN, "row-1", world.sam.id, "Sample item");
    addRow(world.samsSpace, DIARY, "row-2", world.sam.id, "Sample entry");
    addSettings(world.samsSpace, OWN, null, world.sam.id, { sections: [] });
    addSettings(world.samsSpace, DIARY, null, world.sam.id, {});
    await remove(SAM, world.samsSpace, OWN);
    await remove(SAM, world.samsSpace, DIARY);
    await expectDone(await deleteData(SAM, world.samsSpace, OWN));
    expect(count(world.db, "app_rows", world.samsSpace, OWN)).toBe(0);
    expect(count(world.db, "app_settings", world.samsSpace, OWN)).toBe(0);
    expect(count(world.db, "app_rows", world.samsSpace, DIARY)).toBe(1);
    expect(count(world.db, "app_settings", world.samsSpace, DIARY)).toBe(1);
    expect(count(world.db, "space_apps", world.samsSpace, DIARY)).toBe(1);
    expect(count(world.db, "made_apps", world.samsSpace, DIARY)).toBe(1);
  });

  it("then lets the app be added again, empty", async () => {
    await filled();
    await remove(SAM, world.family, ours);
    await deleteData(SAM, world.family, ours);
    await expectError(await deleteData(SAM, world.family, ours), 404, "not_found");
    const again = await addBuiltIn(SAM, world.family);
    expect(again).not.toBe(ours);
    expect(left(world.family, again)).toEqual([1, 0, 0, 0, 0, 1]);
    // Access starts afresh as well: the members who had it before do not.
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
  });

  it("is allowed without removing first when the server holds no app for it", async () => {
    await filled();
    unreadable(world.db, ours);
    await expectDone(await deleteData(SAM, world.family, ours));
    expect(left(world.family, ours)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(left(world.samsSpace, OWN)).toEqual([1, 1, 1, 0, 0, 1]);
    // And for an install a release before the built-in apps left, which could not move.
    install(world.db, world.family, "grocery", world.sam.id, { memberAccess: "edit" });
    addRow(world.family, "grocery", "row-4", world.sam.id, "Sample item four");
    await expectDone(await deleteData(SAM, world.family, "grocery"));
    expect(left(world.family, "grocery")).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it.each([
    ["another app's ID", () => ({ confirm: OWN })],
    ["the ID in other letters", () => ({ confirm: ours.toUpperCase() })],
    ["nothing typed", () => ({ confirm: "" })],
    ["no confirmation", () => ({})],
    ["a confirmation that is not text", () => ({ confirm: true })],
    ["a property the contract does not name", () => ({ confirm: ours, force: true })],
    ["no body at all", () => undefined],
  ])("needs the app's ID typed as confirmation: refuses %s", async (_label, body) => {
    await filled();
    await remove(SAM, world.family, ours);
    const response = await call(SAM, "DELETE", `/api/spaces/${world.family}/apps/${ours}/data`, body());
    await expectError(response, 400, "invalid_request");
    expect(left(world.family, ours)).toEqual([1, 2, 2, 1, 1, 1]);
  });

  it("is for owners: a member gets 403 whether or not the space ever had the app", async () => {
    await filled();
    await remove(SAM, world.family, ours);
    await expectError(await deleteData(KIM, world.family, ours), 403, "forbidden");
    await expectError(await deleteData(LIN, world.family, ours), 403, "forbidden");
    await expectError(await deleteData(LIN, world.family, DIARY), 403, "forbidden");
    expect(left(world.family, ours)).toEqual([1, 2, 2, 1, 1, 1]);
  });

  it.each([
    ["someone who is not in the space", () => [NOA, world.family, ours] as const],
    ["an app the space never had", () => [SAM, world.family, OWN] as const],
    ["a space that does not exist", () => [SAM, "nowhere", ours] as const],
  ])("answers 404 for %s", async (_label, request) => {
    await filled();
    await remove(SAM, world.family, ours);
    const [who, spaceId, appId] = request();
    await expectError(await deleteData(who, spaceId, appId), 404, "not_found");
    expect(left(world.family, ours)).toEqual([1, 2, 2, 1, 1, 1]);
  });
});

describe("addresses that are not routes", () => {
  it.each([
    ["GET", "/apps/m-samslist00"],
    ["POST", "/apps/m-samslist00"],
    ["PATCH", "/apps/m-samslist00"],
    ["GET", "/apps/m-samslist00/data"],
    ["PUT", "/apps/m-samslist00/data"],
    ["DELETE", "/apps"],
    ["DELETE", "/apps/m-samslist00/data/more"],
    // An app's own queries and mutations, and its jobs, went with the apps of the build.
    ["POST", "/apps/m-samslist00/q/list"],
    ["POST", "/apps/m-samslist00/m/add"],
    ["GET", "/apps/m-samslist00/jobs/refresh"],
    ["POST", "/apps/m-samslist00/jobs/refresh/run"],
  ])("%s .../spaces/:spaceId%s -> 404", async (method, rest) => {
    makeApp(world.db, world.samsSpace, OWN, world.sam.id);
    const response = await call(SAM, method, `/api/spaces/${world.samsSpace}${rest}`, method === "GET" ? undefined : {});
    await expectError(response, 404, "not_found");
    expect(installs(world.db)).toMatchObject([{ removedAt: null }]);
  });
});
