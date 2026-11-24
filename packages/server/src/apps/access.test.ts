/**
 * Who can use which app in a space, as its owners decide it
 * (docs/mini-app-contract.md, sections A6 "Access" and A8): the owners' list
 * of a space's apps (GET /api/spaces/:spaceId/apps) and the access route
 * (PUT /api/spaces/:spaceId/apps/:appId/access), and what members then see
 * and may do with an app made in Hearth: its page and its rows. The
 * Testable line of build step 10 is the first block.
 */
import { apiErrorSchema, sessionSchema, spaceAppsSchema, type ApiErrorCode, type SpaceApps } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { as, testApp } from "../testing";
import { family, grant, install, JOURNAL, KIM, LIN, makeApp, NOA, NOW, SAM, unreadable } from "./test-world";

const BASE = "http://hearth.example.com";
const CHECKLIST = "m-checklist0";
const FEED = "m-feed000000";
const JOURNAL_APP = "m-journal000";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

beforeEach(() => {
  world = family();
  ({ app, errors } = testApp({ db: world.db }));
});

function call(who: string, method: string, path: string, body?: unknown, on = app) {
  const headers: Record<string, string> = as(who);
  if (body !== undefined) headers["content-type"] = "application/json";
  return on.request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Who asks about which app in which space; made when the test runs, once the world exists. */
const at = (request: () => [who: string, spaceId: string, appId: string]) => request;
/** Who asks about which space. */
const about = (request: () => [who: string, spaceId: string]) => request;

const setAccess = (who: string, spaceId: string, appId: string, body: unknown) =>
  call(who, "PUT", `/api/spaces/${spaceId}/apps/${appId}/access`, body);
const spaceApps = (who: string, spaceId: string, on = app) => call(who, "GET", `/api/spaces/${spaceId}/apps`, undefined, on);
/** The checklist's items, as its page reads them. */
const items = (who: string, spaceId: string, appId: string) => call(who, "GET", `/api/spaces/${spaceId}/apps/${appId}/rows/items`);
/** An item added, as its page adds one. */
const addItem = (who: string, spaceId: string, appId: string, name: string) =>
  call(who, "POST", `/api/spaces/${spaceId}/apps/${appId}/rows/items`, { data: { name } });

async function expectDone(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

/** What a person's session lists, as "space/app: access". */
async function seenBy(who: string): Promise<string[]> {
  const response = await call(who, "GET", "/api/session");
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json()).apps.map((entry) => `${entry.spaceId}/${entry.id}: ${entry.access}`);
}

/** The owners' list, checked strictly against the contract. */
async function listOf(who: string, spaceId: string, on = app): Promise<SpaceApps> {
  const response = await spaceApps(who, spaceId, on);
  expect(response.status).toBe(200);
  return spaceAppsSchema.parse(await response.json());
}

const exceptions = () =>
  world.db
    .prepare("SELECT app_id AS appId, user_id AS userId, level FROM app_access WHERE space_id = 'family' ORDER BY app_id, user_id")
    .all();

const memberAccess = (appId: string) =>
  (world.db.prepare("SELECT member_access AS level FROM space_apps WHERE space_id = 'family' AND app_id = ?").get(appId) as { level: string })
    .level;

describe("build step 10: access, as members live it", () => {
  it("hides an app from a member with no access: it is absent from their session and every route of it is 404", async () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "edit" });
    expect(await seenBy(LIN)).toEqual([`${world.family}/${CHECKLIST}: edit`]);

    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { members: { [world.lin.id]: "none" } }));
    expect(await seenBy(LIN)).toEqual([]);
    await expectError(await items(LIN, world.family, CHECKLIST), 404, "not_found");
    await expectError(await addItem(LIN, world.family, CHECKLIST, "Milk"), 404, "not_found");
    await expectError(await call(LIN, "GET", `/api/spaces/${world.family}/apps/${CHECKLIST}/frame`), 404, "not_found");
    await expectError(await call(LIN, "GET", `/api/spaces/${world.family}/apps/${CHECKLIST}/settings`), 404, "not_found");
    await expectError(await call(LIN, "PATCH", `/api/spaces/${world.family}/apps/${CHECKLIST}/me`, { pinned: true }), 404, "not_found");
    // Everyone else keeps what they had.
    expect(await seenBy(KIM)).toEqual([`${world.family}/${CHECKLIST}: edit`]);
    expect(await seenBy(SAM)).toEqual([`${world.family}/${CHECKLIST}: edit`]);

    // And the same when the app gives every member nothing.
    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { memberAccess: "none", members: { [world.lin.id]: null } }));
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
    await expectError(await items(KIM, world.family, CHECKLIST), 404, "not_found");
  });

  it("lets a member with view read and not change anything", async () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id);
    expect((await addItem(SAM, world.family, CHECKLIST, "Milk")).status).toBe(201);
    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { memberAccess: "view" }));
    expect(await seenBy(LIN)).toEqual([`${world.family}/${CHECKLIST}: view`]);

    const list = await items(LIN, world.family, CHECKLIST);
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { rows: { id: string; name: string }[] }).rows;
    expect(rows.map((item) => item.name)).toEqual(["Milk"]);
    const base = `/api/spaces/${world.family}/apps/${CHECKLIST}/rows/items`;
    await expectError(await addItem(LIN, world.family, CHECKLIST, "Bread"), 403, "forbidden");
    await expectError(await call(LIN, "PATCH", `${base}/${rows[0]?.id}`, { data: { done: true } }), 403, "forbidden");
    await expectError(await call(LIN, "POST", `${base}/replace`, { where: { done: true }, rows: [] }), 403, "forbidden");
    await expectError(await call(LIN, "DELETE", `${base}/${rows[0]?.id}`), 403, "forbidden");
    await expectError(
      await call(LIN, "PATCH", `/api/spaces/${world.family}/apps/${CHECKLIST}/settings`, { space: { sections: ["Garden"] } }),
      403,
      "forbidden",
    );
    expect(((await (await items(SAM, world.family, CHECKLIST)).json()) as { rows: unknown[] }).rows).toEqual([
      expect.objectContaining({ name: "Milk" }),
    ]);

    // An exception gives one member edit; the others still only view.
    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { members: { [world.kim.id]: "edit" } }));
    expect((await addItem(KIM, world.family, CHECKLIST, "Bread")).status).toBe(201);
    await expectError(await addItem(LIN, world.family, CHECKLIST, "Eggs"), 403, "forbidden");
  });

  it("gives a new member what the app gives every member, whether they were on the server or invited", async () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "view" });
    makeApp(world.db, world.family, FEED, world.sam.id, { memberAccess: "edit" });
    makeApp(world.db, world.family, JOURNAL_APP, world.sam.id, { manifest: JOURNAL, memberAccess: "edit", removedAt: NOW });

    // Noa is on the server already.
    expect((await call(SAM, "POST", `/api/spaces/${world.family}/members`, { email: NOA })).status).toBe(200);
    expect(await seenBy(NOA)).toEqual([`${world.family}/${CHECKLIST}: view`, `${world.family}/${FEED}: edit`]);
    // Pat is not: they get the same when they first arrive.
    expect((await call(SAM, "POST", `/api/spaces/${world.family}/members`, { email: "pat@example.com" })).status).toBe(200);
    expect(await seenBy("pat@example.com")).toEqual([`${world.family}/${CHECKLIST}: view`, `${world.family}/${FEED}: edit`]);

    // A later change of what every member gets reaches them all, but not past an exception.
    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { memberAccess: "edit", members: { [world.lin.id]: "view" } }));
    expect(await seenBy(NOA)).toEqual([`${world.family}/${CHECKLIST}: edit`, `${world.family}/${FEED}: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/${CHECKLIST}: view`, `${world.family}/${FEED}: edit`]);
  });

  it("lets a member an owner allowed to add apps add one, and gives them edit", async () => {
    const addFromCatalog = (who: string, templateId: string, body: unknown = {}) =>
      call(who, "POST", `/api/spaces/${world.family}/catalog/${templateId}`, body);
    await expectError(await addFromCatalog(LIN, "grocery"), 403, "forbidden");
    await expectDone(await call(SAM, "PATCH", `/api/spaces/${world.family}/members/${world.lin.id}`, { canAddApps: true }));
    const added = await addFromCatalog(LIN, "grocery", { memberAccess: "view" });
    expect(added.status).toBe(201);
    const { appId } = (await added.json()) as { appId: string };
    expect(await seenBy(LIN)).toEqual([`${world.family}/${appId}: edit`]);
    expect(await seenBy(KIM)).toEqual([`${world.family}/${appId}: view`]);
    expect(exceptions()).toEqual([{ appId, userId: world.lin.id, level: "edit" }]);

    // Taken away again, the right goes; the app they added stays theirs to use.
    await expectDone(await call(SAM, "PATCH", `/api/spaces/${world.family}/members/${world.lin.id}`, { canAddApps: false }));
    await expectError(await addFromCatalog(LIN, "ideas"), 403, "forbidden");
    expect(await seenBy(LIN)).toEqual([`${world.family}/${appId}: edit`]);
  });
});

describe("PUT /api/spaces/:spaceId/apps/:appId/access", () => {
  beforeEach(() => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "view" });
  });

  it("sets what every member gets and exceptions together, and takes an exception away with null", async () => {
    await expectDone(
      await setAccess(SAM, world.family, CHECKLIST, { memberAccess: "none", members: { [world.lin.id]: "edit", [world.kim.id]: "view" } }),
    );
    expect(memberAccess(CHECKLIST)).toBe("none");
    expect(exceptions()).toEqual(
      [
        { appId: CHECKLIST, userId: world.lin.id, level: "edit" },
        { appId: CHECKLIST, userId: world.kim.id, level: "view" },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
    expect(await seenBy(LIN)).toEqual([`${world.family}/${CHECKLIST}: edit`]);

    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { members: { [world.lin.id]: "none", [world.kim.id]: null } }));
    expect(exceptions()).toEqual([{ appId: CHECKLIST, userId: world.lin.id, level: "none" }]);
    expect(memberAccess(CHECKLIST)).toBe("none");
    // Nothing named, nothing changed.
    await expectDone(await setAccess(SAM, world.family, CHECKLIST, {}));
    expect(exceptions()).toEqual([{ appId: CHECKLIST, userId: world.lin.id, level: "none" }]);
  });

  it("is for any owner of the space", async () => {
    await call(SAM, "PATCH", `/api/spaces/${world.family}/members/${world.lin.id}`, { role: "owner" });
    await expectDone(await setAccess(LIN, world.family, CHECKLIST, { memberAccess: "edit" }));
    expect(memberAccess(CHECKLIST)).toBe("edit");
  });

  it("stores an exception for an owner, which counts only once they are a member again", async () => {
    await expectDone(await setAccess(SAM, world.family, CHECKLIST, { members: { [world.sam.id]: "none" } }));
    expect(await seenBy(SAM)).toEqual([`${world.family}/${CHECKLIST}: edit`]);
  });

  it.each([
    ["a member who can change the app", at(() => [KIM, world.family, CHECKLIST]), 403, "forbidden"],
    ["a member who may only look at it", at(() => [LIN, world.family, CHECKLIST]), 403, "forbidden"],
    ["someone outside the space", at(() => [NOA, world.family, CHECKLIST]), 404, "not_found"],
    ["an owner, about an app the space does not have", at(() => [SAM, world.family, FEED]), 404, "not_found"],
    ["an owner, in a space that does not exist", at(() => [SAM, "nowhere", CHECKLIST]), 404, "not_found"],
  ] as const)("is refused to %s", async (_label, request, status, code) => {
    const [who, spaceId, appId] = request();
    await expectError(await setAccess(who, spaceId, appId, { memberAccess: "edit" }), status, code);
    expect(memberAccess(CHECKLIST)).toBe("view");
  });

  it("answers 404 for a removed app and for one the server holds no app for, also to an owner", async () => {
    makeApp(world.db, world.family, JOURNAL_APP, world.sam.id, { manifest: JOURNAL, removedAt: NOW });
    await expectError(await setAccess(SAM, world.family, JOURNAL_APP, { memberAccess: "edit" }), 404, "not_found");
    // Its manifest is one this release cannot read.
    unreadable(world.db, CHECKLIST);
    await expectError(await setAccess(SAM, world.family, CHECKLIST, { memberAccess: "edit" }), 404, "not_found");
    expect(memberAccess(CHECKLIST)).toBe("view");
    // An install a release before the built-in apps left, which did not move.
    install(world.db, world.family, "grocery", world.sam.id, { memberAccess: "view" });
    await expectError(await setAccess(SAM, world.family, "grocery", { memberAccess: "edit" }), 404, "not_found");
    expect(memberAccess("grocery")).toBe("view");
  });

  it("refuses an exception for someone outside the space, and then saves nothing of the request", async () => {
    await expectError(
      await setAccess(SAM, world.family, CHECKLIST, { memberAccess: "edit", members: { [world.lin.id]: "edit", [world.noa.id]: "view" } }),
      400,
      "invalid_request",
    );
    expect(memberAccess(CHECKLIST)).toBe("view");
    expect(exceptions()).toEqual([]);
  });

  it.each([
    ["a level that does not exist", { memberAccess: "owner" }],
    ["null for what every member gets", { memberAccess: null }],
    ["an exception that is not a level", { members: { someone: "admin" } }],
    ["a property the contract does not name", { memberAccess: "edit", pinned: true }],
    ["text that is not JSON", "{ memberAccess"],
  ])("refuses %s", async (_label, body) => {
    await expectError(await setAccess(SAM, world.family, CHECKLIST, body), 400, "invalid_request");
    expect(memberAccess(CHECKLIST)).toBe("view");
  });

  it("logs nothing for what it turns down", async () => {
    await setAccess(LIN, world.family, CHECKLIST, { memberAccess: "edit" });
    await setAccess(SAM, world.family, CHECKLIST, { members: { nobody: "edit" } });
    expect(errors).toEqual([]);
  });
});

describe("GET /api/spaces/:spaceId/apps", () => {
  it("shows an owner every app the space has, who can use it, and everyone in it", async () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "view", createdAt: "2026-01-05T00:00:00.000Z" });
    makeApp(world.db, world.family, JOURNAL_APP, world.sam.id, { manifest: JOURNAL, removedAt: NOW, createdAt: "2026-01-06T00:00:00.000Z" });
    // An install a release before the built-in apps left, which did not move: the server holds no app of its ID.
    install(world.db, world.family, "retired", world.sam.id, { memberAccess: "edit", createdAt: "2026-01-07T00:00:00.000Z" });
    grant(world.db, world.family, CHECKLIST, world.lin.id, "edit", world.sam.id);
    grant(world.db, world.family, CHECKLIST, world.kim.id, "none", world.sam.id);
    // Left out of what an assistant may use.
    world.db.prepare("UPDATE space_apps SET assistant = 0 WHERE space_id = ? AND app_id = 'retired'").run(world.family);
    for (const name of ["Milk", "Bread"]) {
      expect((await addItem(SAM, world.family, CHECKLIST, name)).status).toBe(201);
    }
    await call(SAM, "POST", `/api/spaces/${world.family}/members`, { email: "pat@example.com", role: "owner" });

    const response = await spaceApps(SAM, world.family);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(spaceAppsSchema.safeParse(body).success).toBe(true);
    // Compared as sent, so that a field the contract does not name would fail too.
    expect(body).toEqual({
      apps: [
        {
          id: CHECKLIST,
          hasCode: true,
          removedAt: null,
          rowCount: 2,
          memberAccess: "view",
          members: { [world.lin.id]: "edit", [world.kim.id]: "none" },
          assistant: true,
          name: { en: "Checklist", zh: "清单" },
          icon: "list-checks",
          color: "teal",
        },
        // A removed app is named and drawn as well, so that its owners can bring it back or delete it.
        {
          id: JOURNAL_APP,
          hasCode: true,
          removedAt: NOW,
          rowCount: 0,
          memberAccess: "none",
          members: {},
          assistant: true,
          name: { en: "Journal", zh: "日记" },
          icon: "notebook-text",
          color: "purple",
        },
        { id: "retired", hasCode: false, removedAt: null, rowCount: 0, memberAccess: "edit", members: {}, assistant: false },
      ],
      members: [
        { id: world.sam.id, name: "owner", role: "owner", email: SAM, canAddApps: false },
        { id: world.lin.id, name: "lin", role: "member", email: LIN, canAddApps: false },
        { id: world.kim.id, name: "kim", role: "member", email: KIM, canAddApps: true },
      ],
      invitations: [{ email: "pat@example.com", role: "owner", canAddApps: false }],
    });
  });

  it("counts only the space's own rows of each app", async () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id);
    // The same app's ID in Sam's own space too, as the tables allow, with a row there.
    install(world.db, world.samsSpace, CHECKLIST, world.sam.id);
    world.db
      .prepare(
        `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
         VALUES ('own-row', ?, ?, 'items', '{"name":"Mine"}', ?, ?, ?, ?)`,
      )
      .run(world.samsSpace, CHECKLIST, world.sam.id, world.sam.id, NOW, NOW);
    expect((await listOf(SAM, world.family)).apps.map((entry) => entry.rowCount)).toEqual([0]);
    expect((await listOf(SAM, world.samsSpace)).apps.map((entry) => entry.rowCount)).toEqual([1]);
  });

  it("works for a personal space too, whose one member is its owner", async () => {
    makeApp(world.db, world.linsSpace, CHECKLIST, world.lin.id, { removedAt: NOW });
    expect(await listOf(LIN, world.linsSpace)).toEqual({
      apps: [
        {
          id: CHECKLIST,
          hasCode: true,
          removedAt: NOW,
          rowCount: 0,
          memberAccess: "none",
          members: {},
          assistant: true,
          name: { en: "Checklist", zh: "清单" },
          icon: "list-checks",
          color: "teal",
        },
      ],
      members: [{ id: world.lin.id, name: "lin", role: "owner", email: LIN, canAddApps: false }],
      invitations: [],
    });
  });

  it.each([
    ["a member, even one who may add apps", about(() => [KIM, world.family]), 403, "forbidden"],
    ["someone outside the space", about(() => [NOA, world.family]), 404, "not_found"],
    ["someone about another person's personal space", about(() => [SAM, world.linsSpace]), 404, "not_found"],
    ["anyone, about a space that does not exist", about(() => [SAM, "nowhere"]), 404, "not_found"],
  ] as const)("is refused to %s", async (_label, request, status, code) => {
    const [who, spaceId] = request();
    await expectError(await spaceApps(who, spaceId), status, code);
  });
});

it("describes access in a way that matches what each member's session lists", async () => {
  makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "view" });
  makeApp(world.db, world.family, FEED, world.sam.id, { memberAccess: "none" });
  makeApp(world.db, world.family, JOURNAL_APP, world.sam.id, { manifest: JOURNAL, memberAccess: "edit", removedAt: NOW });
  install(world.db, world.family, "retired", world.sam.id, { memberAccess: "edit" });
  grant(world.db, world.family, FEED, world.kim.id, "edit", world.sam.id);
  grant(world.db, world.family, CHECKLIST, world.lin.id, "none", world.sam.id);
  grant(world.db, world.family, CHECKLIST, world.sam.id, "none", world.sam.id);

  const list = await listOf(SAM, world.family);
  expect(list.members.map((member) => member.email)).toEqual([SAM, LIN, KIM]);
  for (const member of list.members) {
    // How the web app's table reads the list: an owner has edit, a member their exception or the default.
    const expected = list.apps.flatMap((entry) => {
      const level = member.role === "owner" ? "edit" : (entry.members[member.id] ?? entry.memberAccess);
      return entry.removedAt === null && entry.hasCode && level !== "none" ? [`${world.family}/${entry.id}: ${level}`] : [];
    });
    const seen = (await seenBy(member.email)).filter((line) => line.startsWith(`${world.family}/`));
    expect(seen, member.email).toEqual(expected);
  }
});
