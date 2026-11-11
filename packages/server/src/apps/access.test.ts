/**
 * Who can use which app in a space, as its owners decide it
 * (docs/mini-app-contract.md, sections A6 "Access" and A8): the owners' list
 * of a space's apps (GET /api/spaces/:spaceId/apps) and the access route
 * (PUT /api/spaces/:spaceId/apps/:appId/access), and what members then see
 * and may do. The Testable line of build step 10 is the first block.
 */
import { apiErrorSchema, sessionSchema, spaceAppsSchema, type ApiErrorCode, type SpaceApps } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { as, testApp } from "../testing";
import type { BundledApp } from "./registry";
import { APPS, family, grant, install, KIM, LIN, NOA, NOW, SAM } from "./test-world";

const BASE = "http://hearth.example.com";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

function serverWith(apps: readonly BundledApp[]) {
  return testApp({ db: world.db, apps });
}

beforeEach(() => {
  world = family();
  ({ app, errors } = serverWith(APPS));
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
const query = (who: string, spaceId: string, appId: string, name: string) =>
  call(who, "POST", `/api/spaces/${spaceId}/apps/${appId}/q/${name}`, {});
const mutate = (who: string, spaceId: string, appId: string, name: string, input?: unknown) =>
  call(who, "POST", `/api/spaces/${spaceId}/apps/${appId}/m/${name}`, input === undefined ? {} : { input });

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
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: edit`]);

    await expectDone(await setAccess(SAM, world.family, "checklist", { members: { [world.lin.id]: "none" } }));
    expect(await seenBy(LIN)).toEqual([]);
    await expectError(await query(LIN, world.family, "checklist", "list"), 404, "not_found");
    await expectError(await mutate(LIN, world.family, "checklist", "add", { name: "Milk" }), 404, "not_found");
    await expectError(await call(LIN, "GET", `/api/spaces/${world.family}/apps/checklist/settings`), 404, "not_found");
    await expectError(await call(LIN, "PATCH", `/api/spaces/${world.family}/apps/checklist/me`, { pinned: true }), 404, "not_found");
    // Everyone else keeps what they had.
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);

    // And the same when the app gives every member nothing.
    await expectDone(await setAccess(SAM, world.family, "checklist", { memberAccess: "none", members: { [world.lin.id]: null } }));
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
    await expectError(await query(KIM, world.family, "checklist", "list"), 404, "not_found");
  });

  it("lets a member with view read and not change anything", async () => {
    install(world.db, world.family, "checklist", world.sam.id);
    expect((await mutate(SAM, world.family, "checklist", "add", { name: "Milk" })).status).toBe(200);
    await expectDone(await setAccess(SAM, world.family, "checklist", { memberAccess: "view" }));
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: view`]);

    const list = await query(LIN, world.family, "checklist", "list");
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { output: { id: string; name: string }[] }).output;
    expect(items.map((item) => item.name)).toEqual(["Milk"]);
    await expectError(await mutate(LIN, world.family, "checklist", "add", { name: "Bread" }), 403, "forbidden");
    await expectError(await mutate(LIN, world.family, "checklist", "tick", { id: items[0]?.id, done: true }), 403, "forbidden");
    await expectError(await mutate(LIN, world.family, "checklist", "clearTicked"), 403, "forbidden");
    await expectError(
      await call(LIN, "PATCH", `/api/spaces/${world.family}/apps/checklist/settings`, { space: { sections: ["Garden"] } }),
      403,
      "forbidden",
    );

    // An exception gives one member edit; the others still only view.
    await expectDone(await setAccess(SAM, world.family, "checklist", { members: { [world.kim.id]: "edit" } }));
    expect((await mutate(KIM, world.family, "checklist", "add", { name: "Bread" })).status).toBe(200);
    await expectError(await mutate(LIN, world.family, "checklist", "add", { name: "Eggs" }), 403, "forbidden");
  });

  it("gives a new member what the app gives every member, whether they were on the server or invited", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
    install(world.db, world.family, "feed", world.sam.id, { memberAccess: "edit" });
    install(world.db, world.family, "journal", world.sam.id, { memberAccess: "edit", removedAt: NOW });

    // Noa is on the server already.
    expect((await call(SAM, "POST", `/api/spaces/${world.family}/members`, { email: NOA })).status).toBe(200);
    expect(await seenBy(NOA)).toEqual([`${world.family}/checklist: view`, `${world.family}/feed: edit`]);
    // Pat is not: they get the same when they first arrive.
    expect((await call(SAM, "POST", `/api/spaces/${world.family}/members`, { email: "pat@example.com" })).status).toBe(200);
    expect(await seenBy("pat@example.com")).toEqual([`${world.family}/checklist: view`, `${world.family}/feed: edit`]);

    // A later change of what every member gets reaches them all, but not past an exception.
    await expectDone(await setAccess(SAM, world.family, "checklist", { memberAccess: "edit", members: { [world.lin.id]: "view" } }));
    expect(await seenBy(NOA)).toEqual([`${world.family}/checklist: edit`, `${world.family}/feed: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: view`, `${world.family}/feed: edit`]);
  });

  it("lets a member an owner allowed to add apps add one, and gives them edit", async () => {
    await expectError(await call(LIN, "PUT", `/api/spaces/${world.family}/apps/checklist`, {}), 403, "forbidden");
    await expectDone(await call(SAM, "PATCH", `/api/spaces/${world.family}/members/${world.lin.id}`, { canAddApps: true }));
    await expectDone(await call(LIN, "PUT", `/api/spaces/${world.family}/apps/checklist`, { memberAccess: "view" }));
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: view`]);
    expect(exceptions()).toEqual([{ appId: "checklist", userId: world.lin.id, level: "edit" }]);

    // Taken away again, the right goes; the app they added stays theirs to use.
    await expectDone(await call(SAM, "PATCH", `/api/spaces/${world.family}/members/${world.lin.id}`, { canAddApps: false }));
    await expectError(await call(LIN, "PUT", `/api/spaces/${world.family}/apps/feed`, {}), 403, "forbidden");
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: edit`]);
  });
});

describe("PUT /api/spaces/:spaceId/apps/:appId/access", () => {
  beforeEach(() => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
  });

  it("sets what every member gets and exceptions together, and takes an exception away with null", async () => {
    await expectDone(
      await setAccess(SAM, world.family, "checklist", { memberAccess: "none", members: { [world.lin.id]: "edit", [world.kim.id]: "view" } }),
    );
    expect(memberAccess("checklist")).toBe("none");
    expect(exceptions()).toEqual(
      [
        { appId: "checklist", userId: world.lin.id, level: "edit" },
        { appId: "checklist", userId: world.kim.id, level: "view" },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: edit`]);

    await expectDone(await setAccess(SAM, world.family, "checklist", { members: { [world.lin.id]: "none", [world.kim.id]: null } }));
    expect(exceptions()).toEqual([{ appId: "checklist", userId: world.lin.id, level: "none" }]);
    expect(memberAccess("checklist")).toBe("none");
    // Nothing named, nothing changed.
    await expectDone(await setAccess(SAM, world.family, "checklist", {}));
    expect(exceptions()).toEqual([{ appId: "checklist", userId: world.lin.id, level: "none" }]);
  });

  it("is for any owner of the space", async () => {
    await call(SAM, "PATCH", `/api/spaces/${world.family}/members/${world.lin.id}`, { role: "owner" });
    await expectDone(await setAccess(LIN, world.family, "checklist", { memberAccess: "edit" }));
    expect(memberAccess("checklist")).toBe("edit");
  });

  it("stores an exception for an owner, which counts only once they are a member again", async () => {
    await expectDone(await setAccess(SAM, world.family, "checklist", { members: { [world.sam.id]: "none" } }));
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
  });

  it.each([
    ["a member who can change the app", at(() => [KIM, world.family, "checklist"]), 403, "forbidden"],
    ["a member who may only look at it", at(() => [LIN, world.family, "checklist"]), 403, "forbidden"],
    ["someone outside the space", at(() => [NOA, world.family, "checklist"]), 404, "not_found"],
    ["an owner, about an app the space does not have", at(() => [SAM, world.family, "feed"]), 404, "not_found"],
    ["an owner, in a space that does not exist", at(() => [SAM, "nowhere", "checklist"]), 404, "not_found"],
  ] as const)("is refused to %s", async (_label, request, status, code) => {
    const [who, spaceId, appId] = request();
    await expectError(await setAccess(who, spaceId, appId, { memberAccess: "edit" }), status, code);
    expect(memberAccess("checklist")).toBe("view");
  });

  it("answers 404 for a removed app and for one whose code is gone, also to an owner", async () => {
    install(world.db, world.family, "journal", world.sam.id, { removedAt: NOW });
    await expectError(await setAccess(SAM, world.family, "journal", { memberAccess: "edit" }), 404, "not_found");
    const withoutCode = serverWith(APPS.filter((entry) => entry.id !== "checklist")).app;
    const response = await withoutCode.request(`${BASE}/api/spaces/${world.family}/apps/checklist/access`, {
      method: "PUT",
      headers: { ...as(SAM), "content-type": "application/json" },
      body: JSON.stringify({ memberAccess: "edit" }),
    });
    await expectError(response, 404, "not_found");
    expect(memberAccess("checklist")).toBe("view");
  });

  it("refuses an exception for someone outside the space, and then saves nothing of the request", async () => {
    await expectError(
      await setAccess(SAM, world.family, "checklist", { memberAccess: "edit", members: { [world.lin.id]: "edit", [world.noa.id]: "view" } }),
      400,
      "invalid_request",
    );
    expect(memberAccess("checklist")).toBe("view");
    expect(exceptions()).toEqual([]);
  });

  it.each([
    ["a level that does not exist", { memberAccess: "owner" }],
    ["null for what every member gets", { memberAccess: null }],
    ["an exception that is not a level", { members: { someone: "admin" } }],
    ["a property the contract does not name", { memberAccess: "edit", pinned: true }],
    ["text that is not JSON", "{ memberAccess"],
  ])("refuses %s", async (_label, body) => {
    await expectError(await setAccess(SAM, world.family, "checklist", body), 400, "invalid_request");
    expect(memberAccess("checklist")).toBe("view");
  });

  it("logs nothing for what it turns down", async () => {
    await setAccess(LIN, world.family, "checklist", { memberAccess: "edit" });
    await setAccess(SAM, world.family, "checklist", { members: { nobody: "edit" } });
    expect(errors).toEqual([]);
  });
});

describe("GET /api/spaces/:spaceId/apps", () => {
  it("shows an owner every app the space has, who can use it, and everyone in it", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view", createdAt: "2026-01-05T00:00:00.000Z" });
    install(world.db, world.family, "journal", world.sam.id, { removedAt: NOW, createdAt: "2026-01-06T00:00:00.000Z" });
    install(world.db, world.family, "retired", world.sam.id, { memberAccess: "edit", createdAt: "2026-01-07T00:00:00.000Z" });
    grant(world.db, world.family, "checklist", world.lin.id, "edit", world.sam.id);
    grant(world.db, world.family, "checklist", world.kim.id, "none", world.sam.id);
    for (const name of ["Milk", "Bread"]) {
      expect((await mutate(SAM, world.family, "checklist", "add", { name })).status).toBe(200);
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
          id: "checklist",
          hasCode: true,
          removedAt: null,
          rowCount: 2,
          memberAccess: "view",
          members: { [world.lin.id]: "edit", [world.kim.id]: "none" },
        },
        { id: "journal", hasCode: true, removedAt: NOW, rowCount: 0, memberAccess: "none", members: {} },
        { id: "retired", hasCode: false, removedAt: null, rowCount: 0, memberAccess: "edit", members: {} },
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
    install(world.db, world.family, "checklist", world.sam.id);
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    await mutate(SAM, world.samsSpace, "checklist", "add", { name: "Mine" });
    expect((await listOf(SAM, world.family)).apps.map((entry) => entry.rowCount)).toEqual([0]);
    expect((await listOf(SAM, world.samsSpace)).apps.map((entry) => entry.rowCount)).toEqual([1]);
  });

  it("works for a personal space too, whose one member is its owner", async () => {
    install(world.db, world.linsSpace, "checklist", world.lin.id, { removedAt: NOW });
    expect(await listOf(LIN, world.linsSpace)).toEqual({
      apps: [{ id: "checklist", hasCode: true, removedAt: NOW, rowCount: 0, memberAccess: "none", members: {} }],
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
  install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
  install(world.db, world.family, "feed", world.sam.id, { memberAccess: "none" });
  install(world.db, world.family, "journal", world.sam.id, { memberAccess: "edit", removedAt: NOW });
  grant(world.db, world.family, "feed", world.kim.id, "edit", world.sam.id);
  grant(world.db, world.family, "checklist", world.lin.id, "none", world.sam.id);
  grant(world.db, world.family, "checklist", world.sam.id, "none", world.sam.id);

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
