/**
 * Adding an app to a space, removing it, bringing it back and deleting its
 * data, through the routes and as the session shows it
 * (docs/mini-app-contract.md, sections A6 and A8).
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
import { as, testApp } from "../testing";
import type { BundledApp } from "./registry";
import { APPS, count, family, grant, KIM, LIN, NOA, NOW, SAM, setPrefs } from "./test-world";

const BASE = "http://hearth.example.com";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

/** A server over the same database holding the given apps: what a deploy with other code is. */
function serverWith(apps: readonly BundledApp[]) {
  return testApp({ db: world.db, apps });
}

beforeEach(() => {
  world = family();
  ({ app, errors } = serverWith(APPS));
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
    await expectDone(await add(SAM, world.samsSpace, "checklist"));

    const response = await call(SAM, "GET", "/api/session");
    const body = (await response.json()) as { apps: unknown[] };
    // Strict, so that a field the contract does not name would fail too.
    expect(appSummarySchema.strict().array().parse(body.apps)).toEqual([
      {
        id: "checklist",
        spaceId: world.samsSpace,
        name: { en: "Checklist", zh: "清单" },
        description: {
          en: "A list of things to do, ticked off as you go.",
          zh: "一份待办清单，完成一项勾选一项。",
        },
        icon: "list-checks",
        color: "teal",
        widgetSize: "tall",
        access: "edit",
        enabled: true,
        pinned: false,
        hasPage: true,
      },
    ]);
    expect(installs(world.db)).toEqual([
      {
        spaceId: world.samsSpace,
        appId: "checklist",
        memberAccess: "none",
        createdBy: world.sam.id,
        removedAt: null,
      },
    ]);
  });

  it("shows it to nobody else", async () => {
    await add(SAM, world.samsSpace, "checklist");
    expect(await appsOf(LIN)).toEqual([]);
    expect(await appsOf(KIM)).toEqual([]);
  });

  it("lists each app once per space it is in", async () => {
    await add(SAM, world.samsSpace, "checklist");
    await add(SAM, world.samsSpace, "journal");
    await add(SAM, world.family, "checklist");
    expect(await seenBy(SAM)).toEqual([
      `${world.samsSpace}/checklist: edit`,
      `${world.samsSpace}/journal: edit`,
      `${world.family}/checklist: edit`,
    ]);
  });

  it("changes nothing when the app is already there", async () => {
    await add(SAM, world.samsSpace, "checklist");
    addRow(world.samsSpace, "checklist", "row-1", world.sam.id, "Sample item");
    const before = [installs(world.db), dataOf(world.samsSpace, "checklist")];
    await expectDone(await add(SAM, world.samsSpace, "checklist"));
    await expectDone(await add(SAM, world.samsSpace, "checklist", { memberAccess: "none" }));
    expect([installs(world.db), dataOf(world.samsSpace, "checklist")]).toEqual(before);
  });

  it.each([
    ["an app the server does not hold", at(() => [SAM, world.samsSpace, "nothing"])],
    ["an ID that only looks like an app", at(() => [SAM, world.samsSpace, "constructor"])],
    ["someone else's personal space", at(() => [LIN, world.samsSpace, "checklist"])],
    ["a group the person is not in", at(() => [NOA, world.family, "checklist"])],
    ["a space that does not exist", at(() => [SAM, "nowhere", "checklist"])],
  ] as const)("answers 404 for %s and adds nothing", async (_label, request) => {
    const [who, spaceId, appId] = request();
    await expectError(await add(who, spaceId, appId), 404, "not_found");
    expect(installs(world.db)).toEqual([]);
  });

  it.each([
    ["text that is not JSON", "{ memberAccess: view"],
    ["no body at all", undefined],
    ["a list", []],
    ["nothing", null],
    ["a level that does not exist", { memberAccess: "admin" }],
    ["a property the contract does not name", { memberAccess: "view", pinned: true }],
  ])("refuses %s", async (_label, body) => {
    const response = await call(SAM, "PUT", `/api/spaces/${world.samsSpace}/apps/checklist`, body);
    await expectError(response, 400, "invalid_request");
    expect(installs(world.db)).toEqual([]);
  });

  it("needs sign-in, and is refused from another site", async () => {
    const path = `/api/spaces/${world.samsSpace}/apps/checklist`;
    await expectError(await call(null, "PUT", path, {}), 401, "unauthenticated");
    await expectError(await call("stranger@example.com", "PUT", path, {}), 403, "not_a_member");
    const crossSite = await app.request(`${BASE}${path}`, {
      method: "PUT",
      headers: as(SAM, { "content-type": "application/json", origin: "https://evil.example.net" }),
      body: "{}",
    });
    await expectError(crossSite, 403, "invalid_request");
    expect(installs(world.db)).toEqual([]);
  });

  it("refuses an app in a kind of space its manifest does not allow", async () => {
    await expectError(await add(SAM, world.family, "journal"), 409, "conflict");
    expect(installs(world.db)).toEqual([]);
    await expectDone(await add(SAM, world.samsSpace, "journal"));
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/journal: edit`]);
  });

  it("logs nothing for a request it turns down", async () => {
    await add(SAM, world.samsSpace, "nothing");
    await add(LIN, world.family, "checklist");
    await add(SAM, world.family, "journal");
    expect(errors).toEqual([]);
  });
});

describe("adding an app to a group", () => {
  it("shows it to the owners alone unless the person adding it says otherwise", async () => {
    await expectDone(await add(SAM, world.family, "checklist"));
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
  });

  it.each(["view", "edit"] as const)("gives every member %s when asked to", async (memberAccess) => {
    await expectDone(await add(SAM, world.family, "checklist", { memberAccess }));
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: ${memberAccess}`]);
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: ${memberAccess}`]);
    expect(await seenBy(NOA)).toEqual([]);
  });

  it("is refused to a member who may not add apps, whatever the app", async () => {
    await expectError(await add(LIN, world.family, "checklist"), 403, "forbidden");
    await expectError(await add(LIN, world.family, "nothing"), 403, "forbidden");
    expect(installs(world.db)).toEqual([]);
  });

  it("lets a member who may add apps add one, and gives them edit", async () => {
    await expectDone(await add(KIM, world.family, "checklist"));
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: edit`]);
    // The owner sees everything in the group; the other member was not offered it.
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(installs(world.db)).toMatchObject([{ createdBy: world.kim.id, memberAccess: "none" }]);
    expect(
      world.db.prepare("SELECT user_id AS userId, level, created_by AS createdBy FROM app_access").all(),
    ).toEqual([{ userId: world.kim.id, level: "edit", createdBy: world.kim.id }]);
  });

  it("lets that member choose what the others get", async () => {
    await expectDone(await add(KIM, world.family, "checklist", { memberAccess: "view" }));
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: view`]);
  });

  it("does not change access when the app is already there", async () => {
    await add(SAM, world.family, "checklist", { memberAccess: "view" });
    await expectError(await add(SAM, world.family, "checklist", { memberAccess: "edit" }), 409, "conflict");
    await expectError(await add(SAM, world.family, "checklist", { memberAccess: "none" }), 409, "conflict");
    await expectDone(await add(SAM, world.family, "checklist", { memberAccess: "view" }));
    await expectDone(await add(SAM, world.family, "checklist"));
    await expectDone(await add(KIM, world.family, "checklist"));
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: view`]);
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: view`]);
    expect(count(world.db, "app_access", world.family, "checklist")).toBe(0);
  });

  it("does not let a member add their way into an app they were not given", async () => {
    await add(SAM, world.family, "checklist");
    addRow(world.family, "checklist", "row-1", world.sam.id, "Sample item");
    await expectError(await add(KIM, world.family, "checklist"), 409, "conflict");
    await expectError(await add(KIM, world.family, "checklist", { memberAccess: "edit" }), 409, "conflict");
    expect(await seenBy(KIM)).toEqual([]);
    expect(count(world.db, "app_access", world.family, "checklist")).toBe(0);
    expect(installs(world.db)).toMatchObject([{ memberAccess: "none", createdBy: world.sam.id }]);
  });
});

describe("removing an app", () => {
  it("takes it out of everyone's session and keeps its entry", async () => {
    await add(SAM, world.family, "checklist", { memberAccess: "edit" });
    await expectDone(await remove(SAM, world.family, "checklist"));
    expect(await seenBy(SAM)).toEqual([]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(installs(world.db)).toMatchObject([
      { spaceId: world.family, appId: "checklist", removedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    ]);
  });

  it("answers 404 once the app is removed", async () => {
    await add(SAM, world.samsSpace, "checklist");
    await remove(SAM, world.samsSpace, "checklist");
    const removedAt = installs(world.db);
    await expectError(await remove(SAM, world.samsSpace, "checklist"), 404, "not_found");
    expect(installs(world.db)).toEqual(removedAt);
  });

  it("leaves the same app in another space alone", async () => {
    await add(SAM, world.samsSpace, "checklist");
    await add(SAM, world.family, "checklist");
    await add(LIN, world.linsSpace, "checklist");
    await remove(SAM, world.family, "checklist");
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.linsSpace}/checklist: edit`]);
  });

  it("is for owners: a member who can edit the app gets 403", async () => {
    await add(KIM, world.family, "checklist", { memberAccess: "edit" });
    await expectError(await remove(LIN, world.family, "checklist"), 403, "forbidden");
    // Not even the member who added it.
    await expectError(await remove(KIM, world.family, "checklist"), 403, "forbidden");
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: edit`]);
    expect(installs(world.db)).toMatchObject([{ removedAt: null }]);
  });

  it.each([
    ["a member the app is hidden from", at(() => [LIN, world.family, "checklist"])],
    ["someone who is not in the space", at(() => [NOA, world.family, "checklist"])],
    ["an app the space does not have", at(() => [SAM, world.family, "journal"])],
    ["an app the server does not hold", at(() => [SAM, world.family, "nothing"])],
    ["a space that does not exist", at(() => [SAM, "nowhere", "checklist"])],
  ] as const)("answers 404 for %s", async (_label, request) => {
    await add(SAM, world.family, "checklist");
    const [who, spaceId, appId] = request();
    await expectError(await remove(who, spaceId, appId), 404, "not_found");
    expect(installs(world.db)).toMatchObject([{ appId: "checklist", removedAt: null }]);
  });
});

describe("bringing a removed app back", () => {
  it("brings back its data, its settings and each person's switch and pin, untouched", async () => {
    await add(SAM, world.family, "checklist", { memberAccess: "edit" });
    addRow(world.family, "checklist", "row-1", world.sam.id, "Sample item one");
    addRow(world.family, "checklist", "row-2", world.lin.id, "Sample item two");
    addSettings(world.family, "checklist", null, world.sam.id, { sections: ["Sample section"] });
    addSettings(world.family, "checklist", world.lin.id, world.lin.id, { hideDone: true });
    setPrefs(world.db, world.family, "checklist", world.lin.id, { enabled: false, pinned: true });
    const before = dataOf(world.family, "checklist");
    expect(before.rows).toHaveLength(2);
    expect(before.settings).toHaveLength(2);
    expect(before.prefs).toHaveLength(1);

    await expectDone(await remove(SAM, world.family, "checklist"));
    expect(await seenBy(SAM)).toEqual([]);
    expect(dataOf(world.family, "checklist")).toEqual(before);

    await expectDone(await add(SAM, world.family, "checklist", { memberAccess: "edit" }));
    expect(dataOf(world.family, "checklist")).toEqual(before);
    expect(installs(world.db)).toMatchObject([
      { spaceId: world.family, appId: "checklist", removedAt: null, createdBy: world.sam.id },
    ]);
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await appsOf(LIN)).toMatchObject([
      { id: "checklist", spaceId: world.family, access: "edit", enabled: false, pinned: true },
    ]);
  });

  it("works in a personal space too", async () => {
    await add(SAM, world.samsSpace, "checklist");
    addRow(world.samsSpace, "checklist", "row-1", world.sam.id, "Sample item");
    const before = dataOf(world.samsSpace, "checklist");
    await remove(SAM, world.samsSpace, "checklist");
    await expectDone(await add(SAM, world.samsSpace, "checklist"));
    expect(dataOf(world.samsSpace, "checklist")).toEqual(before);
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/checklist: edit`]);
  });

  it("brings it back in that space only", async () => {
    await add(SAM, world.samsSpace, "checklist");
    await add(SAM, world.family, "checklist");
    await remove(SAM, world.samsSpace, "checklist");
    await remove(SAM, world.family, "checklist");
    await expectDone(await add(SAM, world.family, "checklist", { memberAccess: "view" }));
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    // Sam's own space has a random ID, so the two entries come in either order.
    expect(installs(world.db)).toHaveLength(2);
    expect(installs(world.db)).toContainEqual(
      expect.objectContaining({ spaceId: world.family, memberAccess: "view", removedAt: null }),
    );
    expect(installs(world.db)).toContainEqual(
      expect.objectContaining({ spaceId: world.samsSpace, memberAccess: "none", removedAt: expect.any(String) }),
    );
  });

  it("starts access afresh: what is asked for now, and no exceptions from before", async () => {
    await add(SAM, world.family, "checklist", { memberAccess: "edit" });
    grant(world.db, world.family, "checklist", world.kim.id, "edit", world.sam.id);
    await remove(SAM, world.family, "checklist");

    // "Only me for now" means that, whoever could use the app before.
    await expectDone(await add(SAM, world.family, "checklist"));
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
    expect(count(world.db, "app_access", world.family, "checklist")).toBe(0);

    await remove(SAM, world.family, "checklist");
    await expectDone(await add(SAM, world.family, "checklist", { memberAccess: "view" }));
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: view`]);
  });

  it("is for owners: a member who may add apps cannot bring back data they never saw", async () => {
    await add(SAM, world.family, "checklist");
    addRow(world.family, "checklist", "row-1", world.sam.id, "Sample item");
    await remove(SAM, world.family, "checklist");
    const removed = installs(world.db);

    await expectError(await add(KIM, world.family, "checklist"), 409, "conflict");
    expect(installs(world.db)).toEqual(removed);
    expect(await seenBy(KIM)).toEqual([]);
    expect(count(world.db, "app_access", world.family, "checklist")).toBe(0);
    // Nor one who could use it before it was removed.
    world.db.prepare("UPDATE space_apps SET member_access = 'edit'").run();
    await expectError(await add(KIM, world.family, "checklist"), 409, "conflict");
    expect(await seenBy(KIM)).toEqual([]);
  });
});

describe("an app whose code the server no longer holds", () => {
  it("vanishes from the session, answers 404, keeps its data, and returns with the code", async () => {
    await add(SAM, world.samsSpace, "checklist");
    await add(SAM, world.family, "checklist", { memberAccess: "edit" });
    await add(SAM, world.samsSpace, "journal");
    addRow(world.family, "checklist", "row-1", world.sam.id, "Sample item");
    addSettings(world.family, "checklist", null, world.sam.id, { sections: ["Sample section"] });
    const before = [installs(world.db), dataOf(world.family, "checklist")];

    // A deploy without the checklist's folder.
    const without = serverWith(APPS.filter((entry) => entry.id !== "checklist"));
    expect(await seenBy(SAM, without.app)).toEqual([`${world.samsSpace}/journal: edit`]);
    expect(await seenBy(LIN, without.app)).toEqual([]);
    const path = `/api/spaces/${world.family}/apps/checklist`;
    await expectError(await call(SAM, "PUT", path, {}, without.app), 404, "not_found");
    await expectError(await call(SAM, "DELETE", path, undefined, without.app), 404, "not_found");
    await expectError(await call(LIN, "DELETE", path, undefined, without.app), 404, "not_found");
    expect([installs(world.db), dataOf(world.family, "checklist")]).toEqual(before);
    expect(without.errors).toEqual([]);

    // The folder is put back.
    const withCode = serverWith(APPS);
    expect(await seenBy(SAM, withCode.app)).toEqual([
      `${world.samsSpace}/checklist: edit`,
      `${world.samsSpace}/journal: edit`,
      `${world.family}/checklist: edit`,
    ]);
    expect(await seenBy(LIN, withCode.app)).toEqual([`${world.family}/checklist: edit`]);
    expect([installs(world.db), dataOf(world.family, "checklist")]).toEqual(before);
  });
});

describe("deleting an app's data", () => {
  /** The family's checklist with rows, settings, an exception and a pin; the same app in Sam's own space. */
  async function filled() {
    await add(SAM, world.family, "checklist", { memberAccess: "view" });
    addRow(world.family, "checklist", "row-1", world.sam.id, "Sample item one");
    addRow(world.family, "checklist", "row-2", world.lin.id, "Sample item two");
    addSettings(world.family, "checklist", null, world.sam.id, { sections: ["Sample section"] });
    addSettings(world.family, "checklist", world.lin.id, world.lin.id, { hideDone: true });
    grant(world.db, world.family, "checklist", world.kim.id, "edit", world.sam.id);
    setPrefs(world.db, world.family, "checklist", world.lin.id, { enabled: true, pinned: true });
    await add(SAM, world.samsSpace, "checklist");
    addRow(world.samsSpace, "checklist", "row-3", world.sam.id, "Sample item three");
    addSettings(world.samsSpace, "checklist", null, world.sam.id, { sections: [] });
  }

  const left = (spaceId: string) =>
    ["space_apps", "app_rows", "app_settings", "app_access", "app_prefs"].map((table) =>
      count(world.db, table, spaceId, "checklist"),
    );

  it("is refused while the app is in the space", async () => {
    await filled();
    await expectError(await deleteData(SAM, world.family, "checklist"), 409, "conflict");
    expect(left(world.family)).toEqual([1, 2, 2, 1, 1]);
  });

  it("deletes everything a removed app had in that space, and nothing else", async () => {
    await filled();
    await remove(SAM, world.family, "checklist");
    expect(left(world.family)).toEqual([1, 2, 2, 1, 1]);

    await expectDone(await deleteData(SAM, world.family, "checklist"));
    expect(left(world.family)).toEqual([0, 0, 0, 0, 0]);
    // The same app in another space is untouched.
    expect(left(world.samsSpace)).toEqual([1, 1, 1, 0, 0]);
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/checklist: edit`]);
    expect(errors).toEqual([]);
  });

  it("leaves other apps in the same space alone", async () => {
    await add(SAM, world.samsSpace, "checklist");
    await add(SAM, world.samsSpace, "journal");
    addRow(world.samsSpace, "checklist", "row-1", world.sam.id, "Sample item");
    addRow(world.samsSpace, "journal", "row-2", world.sam.id, "Sample entry");
    addSettings(world.samsSpace, "checklist", null, world.sam.id, { sections: [] });
    addSettings(world.samsSpace, "journal", null, world.sam.id, {});
    await remove(SAM, world.samsSpace, "checklist");
    await remove(SAM, world.samsSpace, "journal");
    await expectDone(await deleteData(SAM, world.samsSpace, "checklist"));
    expect(count(world.db, "app_rows", world.samsSpace, "checklist")).toBe(0);
    expect(count(world.db, "app_settings", world.samsSpace, "checklist")).toBe(0);
    expect(count(world.db, "app_rows", world.samsSpace, "journal")).toBe(1);
    expect(count(world.db, "app_settings", world.samsSpace, "journal")).toBe(1);
    expect(count(world.db, "space_apps", world.samsSpace, "journal")).toBe(1);
  });

  it("then lets the app be added again, empty", async () => {
    await filled();
    await remove(SAM, world.family, "checklist");
    await deleteData(SAM, world.family, "checklist");
    await expectError(await deleteData(SAM, world.family, "checklist"), 404, "not_found");
    await expectDone(await add(SAM, world.family, "checklist"));
    expect(left(world.family)).toEqual([1, 0, 0, 0, 0]);
    // Access starts afresh as well: the members who had it before do not.
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
  });

  it("is allowed without removing first when the server holds no code for the app", async () => {
    await filled();
    const without = serverWith([]);
    await expectDone(await call(SAM, "DELETE", `/api/spaces/${world.family}/apps/checklist/data`, { confirm: "checklist" }, without.app));
    expect(left(world.family)).toEqual([0, 0, 0, 0, 0]);
    expect(left(world.samsSpace)).toEqual([1, 1, 1, 0, 0]);
  });

  it.each([
    ["another app's ID", { confirm: "journal" }],
    ["the ID in other letters", { confirm: "Checklist" }],
    ["nothing typed", { confirm: "" }],
    ["no confirmation", {}],
    ["a confirmation that is not text", { confirm: true }],
    ["a property the contract does not name", { confirm: "checklist", force: true }],
    ["no body at all", undefined],
  ])("needs the app's ID typed as confirmation: refuses %s", async (_label, body) => {
    await filled();
    await remove(SAM, world.family, "checklist");
    const response = await call(SAM, "DELETE", `/api/spaces/${world.family}/apps/checklist/data`, body);
    await expectError(response, 400, "invalid_request");
    expect(left(world.family)).toEqual([1, 2, 2, 1, 1]);
  });

  it("is for owners: a member gets 403 whether or not the space ever had the app", async () => {
    await filled();
    await remove(SAM, world.family, "checklist");
    await expectError(await deleteData(KIM, world.family, "checklist"), 403, "forbidden");
    await expectError(await deleteData(LIN, world.family, "checklist"), 403, "forbidden");
    await expectError(await deleteData(LIN, world.family, "journal"), 403, "forbidden");
    expect(left(world.family)).toEqual([1, 2, 2, 1, 1]);
  });

  it.each([
    ["someone who is not in the space", at(() => [NOA, world.family, "checklist"])],
    ["an app the space never had", at(() => [SAM, world.family, "journal"])],
    ["a space that does not exist", at(() => [SAM, "nowhere", "checklist"])],
  ] as const)("answers 404 for %s", async (_label, request) => {
    await filled();
    await remove(SAM, world.family, "checklist");
    const [who, spaceId, appId] = request();
    await expectError(await deleteData(who, spaceId, appId), 404, "not_found");
    expect(left(world.family)).toEqual([1, 2, 2, 1, 1]);
  });
});

describe("the scheduler's wake", () => {
  it("comes when an app is added to a space or brought back, and not when nothing changed", async () => {
    let wakes = 0;
    ({ app } = testApp({ db: world.db, apps: APPS, wakeJobs: () => (wakes += 1) }));
    await expectDone(await add(SAM, world.samsSpace, "checklist"));
    expect(wakes).toBe(1);
    // Already there: nothing new to run.
    await expectDone(await add(SAM, world.samsSpace, "checklist"));
    expect(wakes).toBe(1);
    // Turned down: nothing changed either.
    await expectError(await add(LIN, world.family, "checklist"), 403, "forbidden");
    await expectError(await add(SAM, world.family, "journal"), 409, "conflict");
    expect(wakes).toBe(1);
    // Removing an app gives the scheduler nothing to do; bringing it back may.
    await expectDone(await remove(SAM, world.samsSpace, "checklist"));
    expect(wakes).toBe(1);
    await expectDone(await add(SAM, world.samsSpace, "checklist"));
    expect(wakes).toBe(2);
    // A member who may add apps, in a group.
    await expectDone(await add(KIM, world.family, "checklist"));
    expect(wakes).toBe(3);
  });
});

describe("addresses that are not routes", () => {
  it.each([
    ["GET", "/apps/checklist"],
    ["POST", "/apps/checklist"],
    ["PATCH", "/apps/checklist"],
    ["GET", "/apps/checklist/data"],
    ["PUT", "/apps/checklist/data"],
    ["DELETE", "/apps"],
    ["DELETE", "/apps/checklist/data/more"],
  ])("%s .../spaces/:spaceId%s -> 404", async (method, rest) => {
    await add(SAM, world.samsSpace, "checklist");
    const response = await call(SAM, method, `/api/spaces/${world.samsSpace}${rest}`, method === "GET" ? undefined : {});
    await expectError(response, 404, "not_found");
    expect(installs(world.db)).toMatchObject([{ removedAt: null }]);
  });
});
