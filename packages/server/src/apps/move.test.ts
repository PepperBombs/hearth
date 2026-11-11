/**
 * Moving an app with its data to another space (docs/mini-app-contract.md,
 * sections A6 "Move" and A8, and the owner's decision 3):
 * POST /api/spaces/:spaceId/apps/:appId/move. The Testable line of build
 * step 11 is the first block. The guard that every table about an app in a
 * space follows it when it moves, read from `sqlite_master`, is in
 * src/db/apps-schema.test.ts.
 */
import { apiErrorSchema, appSettingsSchema, sessionSchema, type ApiErrorCode, type AppSettings, type AppSummary } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { as, testApp } from "../testing";
import type { BundledApp } from "./registry";
import { APPS, family, grant, install, KIM, LIN, NOA, NOW, SAM, setPrefs } from "./test-world";

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

const move = (who: string, spaceId: string, appId: string, body: unknown, on = app) =>
  call(who, "POST", `/api/spaces/${spaceId}/apps/${appId}/move`, body, on);
const query = (who: string, spaceId: string, appId: string, name: string) =>
  call(who, "POST", `/api/spaces/${spaceId}/apps/${appId}/q/${name}`, {});
const mutate = (who: string, spaceId: string, appId: string, name: string, input?: unknown) =>
  call(who, "POST", `/api/spaces/${spaceId}/apps/${appId}/m/${name}`, input === undefined ? {} : { input });
const saveSettings = (who: string, spaceId: string, appId: string, patch: unknown) =>
  call(who, "PATCH", `/api/spaces/${spaceId}/apps/${appId}/settings`, patch);
const setMine = (who: string, spaceId: string, appId: string, patch: unknown) =>
  call(who, "PATCH", `/api/spaces/${spaceId}/apps/${appId}/me`, patch);

/** Who asks to move which app out of which space; made when the test runs, once the world exists. */
const at = (request: () => [who: string, spaceId: string, appId: string, toSpaceId: string]) => request;

async function expectDone(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

async function expectOk(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { output?: unknown }).output;
}

async function appsOf(who: string): Promise<AppSummary[]> {
  const response = await call(who, "GET", "/api/session");
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json()).apps;
}

/** What a person's session lists, as "space/app: access". */
async function seenBy(who: string): Promise<string[]> {
  return (await appsOf(who)).map((entry) => `${entry.spaceId}/${entry.id}: ${entry.access}`);
}

type Item = { id: string; name: string; section: string; done: boolean; createdBy: string };

/** The checklist's items in a space, as its own query reads them. */
async function itemsOf(who: string, spaceId: string): Promise<Item[]> {
  return (await expectOk(await query(who, spaceId, "checklist", "list"))) as Item[];
}

async function settingsOf(who: string, spaceId: string, appId: string): Promise<AppSettings> {
  const response = await call(who, "GET", `/api/spaces/${spaceId}/apps/${appId}/settings`);
  expect(response.status).toBe(200);
  return appSettingsSchema.parse(await response.json());
}

/** Everything stored about an app, in every space, to compare before and after. */
function everything(appId: string) {
  const all = (sql: string) => world.db.prepare(sql).all(appId);
  return {
    installs: all("SELECT * FROM space_apps WHERE app_id = ? ORDER BY space_id"),
    rows: all("SELECT * FROM app_rows WHERE app_id = ? ORDER BY id"),
    settings: all("SELECT * FROM app_settings WHERE app_id = ? ORDER BY space_id, user_id"),
    access: all("SELECT * FROM app_access WHERE app_id = ? ORDER BY space_id, user_id"),
    prefs: all("SELECT * FROM app_prefs WHERE app_id = ? ORDER BY space_id, user_id"),
  };
}

/** The rows of a table about one app in one space that are about one person. */
function about(table: "app_prefs" | "app_settings" | "app_access", spaceId: string, userId: string): number {
  return (
    world.db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND app_id = 'checklist' AND user_id = ?`)
      .get(spaceId, userId) as { n: number }
  ).n;
}

/** A second group. Sam owns it, Lin is a plain member; Kim and Noa are not in it. */
function team(): string {
  world.db
    .prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('team', 'group', 'Team', ?, ?)")
    .run(world.sam.id, "2026-01-05T00:00:00.000Z");
  const join = world.db.prepare(
    "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES ('team', ?, ?, 0, ?)",
  );
  join.run(world.sam.id, "owner", "2026-01-05T00:00:00.000Z");
  join.run(world.lin.id, "member", "2026-01-06T00:00:00.000Z");
  return "team";
}

/**
 * The family's checklist as a family uses it: everyone may edit, Kim has an
 * exception to view only, each person wrote an item, the space has its
 * sections, and Sam and Lin each have their own setting, switch and pin.
 */
async function aFamilyChecklist() {
  install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
  await expectOk(await mutate(SAM, world.family, "checklist", "add", { name: "Sample item from Sam" }));
  const fromLin = (await expectOk(await mutate(LIN, world.family, "checklist", "add", { name: "Sample item from Lin", section: "Garden" }))) as Item;
  await expectOk(await mutate(LIN, world.family, "checklist", "tick", { id: fromLin.id, done: true }));
  expect((await saveSettings(SAM, world.family, "checklist", { space: { sections: ["Garden", "House"] } })).status).toBe(200);
  for (const who of [SAM, LIN]) {
    expect((await saveSettings(who, world.family, "checklist", { user: { hideDone: true } })).status).toBe(200);
    await expectDone(await setMine(who, world.family, "checklist", { pinned: true }));
  }
  grant(world.db, world.family, "checklist", world.kim.id, "view", world.sam.id);
}

describe("build step 11: moving an app takes its data along", () => {
  it("brings its rows and the settings of the space to the new space, as they were", async () => {
    await aFamilyChecklist();
    const before = everything("checklist");
    expect(before.rows).toHaveLength(2);

    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: world.samsSpace }));

    const after = everything("checklist");
    // Every row is in Sam's own space now, and says what it said: who wrote it and when included.
    expect(after.rows).toEqual(before.rows.map((row) => ({ ...(row as object), space_id: world.samsSpace })));
    expect(after.installs).toEqual([
      { ...(before.installs[0] as object), space_id: world.samsSpace, member_access: "none" },
    ]);
    // The app's own query reads them there, Lin's ticked item and its section included.
    expect((await itemsOf(SAM, world.samsSpace)).map(({ name, section, done, createdBy }) => ({ name, section, done, createdBy }))).toEqual([
      { name: "Sample item from Sam", section: "", done: false, createdBy: world.sam.id },
      { name: "Sample item from Lin", section: "Garden", done: true, createdBy: world.lin.id },
    ]);
    // The settings everyone shared came along, unchanged, with whoever saved them.
    expect((await settingsOf(SAM, world.samsSpace, "checklist")).space).toEqual({ sections: ["Garden", "House"] });
    const spaceSettings = (rows: unknown[]) => rows.filter((row) => (row as { user_id: string | null }).user_id === null);
    expect(spaceSettings(after.settings)).toEqual(
      spaceSettings(before.settings).map((row) => ({ ...(row as object), space_id: world.samsSpace })),
    );
    // Nothing of it answers at the old address.
    await expectError(await query(SAM, world.family, "checklist", "list"), 404, "not_found");
    expect(errors).toEqual([]);
  });

  it("takes away every exception: access in the new space starts afresh", async () => {
    await aFamilyChecklist();
    team();
    grant(world.db, world.family, "checklist", world.lin.id, "edit", world.sam.id);
    expect(everything("checklist").access).toHaveLength(2);

    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: "team" }));
    expect(everything("checklist").access).toEqual([]);
    // Lin is in the team too, but her exception stayed behind, and members get nothing unless asked.
    expect(await seenBy(LIN)).toEqual([]);
    await expectError(await query(LIN, "team", "checklist", "list"), 404, "not_found");
    expect(await seenBy(SAM)).toEqual(["team/checklist: edit"]);

    // What members of the new space get is what the person moving it chose, and nothing more.
    await expectDone(await move(SAM, "team", "checklist", { toSpaceId: world.family, memberAccess: "edit" }));
    expect(everything("checklist").access).toEqual([]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: edit`]);
    // Kim's exception, which let her view only, did not come back with the app either.
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: edit`]);
  });

  it("keeps the mover's own pin, switch and settings, and deletes those of people not in the new space", async () => {
    await aFamilyChecklist();
    await expectDone(await setMine(SAM, world.family, "checklist", { enabled: false }));

    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: world.samsSpace }));

    expect(await appsOf(SAM)).toEqual([
      expect.objectContaining({ id: "checklist", spaceId: world.samsSpace, access: "edit", enabled: false, pinned: true }),
    ]);
    expect((await settingsOf(SAM, world.samsSpace, "checklist")).user).toEqual({ hideDone: true });
    // Lin is not in Sam's own space: the app is gone for her, and so is what was hers about it.
    expect(await seenBy(LIN)).toEqual([]);
    expect(about("app_prefs", world.samsSpace, world.lin.id)).toBe(0);
    expect(about("app_settings", world.samsSpace, world.lin.id)).toBe(0);
    expect(everything("checklist").prefs).toEqual([
      { space_id: world.samsSpace, app_id: "checklist", user_id: world.sam.id, enabled: 0, pinned: 1 },
    ]);
    // The item she wrote is the app's data, not hers, and went along.
    expect((await itemsOf(SAM, world.samsSpace)).map((item) => item.createdBy)).toContain(world.lin.id);
  });

  it("keeps what is about each person who is in both spaces", async () => {
    await aFamilyChecklist();
    team();
    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: "team", memberAccess: "edit" }));

    // Lin is in the team as well: her pin and her own setting are there for her.
    expect(await appsOf(LIN)).toEqual([expect.objectContaining({ id: "checklist", spaceId: "team", access: "edit", pinned: true })]);
    expect((await settingsOf(LIN, "team", "checklist")).user).toEqual({ hideDone: true });
    expect(await appsOf(SAM)).toEqual([expect.objectContaining({ spaceId: "team", pinned: true })]);
    // Kim is not, and nothing about her came along.
    expect(await seenBy(KIM)).toEqual([]);
    expect(world.db.prepare("SELECT count(*) AS n FROM app_access WHERE user_id = ?").get(world.kim.id)).toEqual({ n: 0 });
  });

  it.each([
    ["has the app", { removedAt: undefined }],
    ["had the app and kept its data", { removedAt: NOW }],
  ])("answers 409 when the new space %s, and changes nothing", async (_label, options) => {
    await aFamilyChecklist();
    install(world.db, world.samsSpace, "checklist", world.sam.id, options);
    world.db
      .prepare(
        `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
         VALUES ('own-row', ?, 'checklist', 'items', '{"name":"Sample own item"}', ?, ?, ?, ?)`,
      )
      .run(world.samsSpace, world.sam.id, world.sam.id, NOW, NOW);
    const before = everything("checklist");

    await expectError(await move(SAM, world.family, "checklist", { toSpaceId: world.samsSpace }), 409, "conflict");
    // Moving it to where it is already is the same answer.
    await expectError(await move(SAM, world.family, "checklist", { toSpaceId: world.family }), 409, "conflict");
    expect(everything("checklist")).toEqual(before);
    expect(errors).toEqual([]);
  });

  it("leaves nothing the database would refuse", async () => {
    await aFamilyChecklist();
    team();
    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: "team" }));
    await expectDone(await move(SAM, "team", "checklist", { toSpaceId: world.samsSpace }));
    expect(world.db.pragma("foreign_key_check")).toEqual([]);
    expect(everything("checklist").installs).toHaveLength(1);
  });
});

describe("who may move an app", () => {
  it("lets a member who may add apps move her own app into the group: it arrives for her and the owners", async () => {
    install(world.db, world.kimsSpace, "checklist", world.kim.id);
    await expectOk(await mutate(KIM, world.kimsSpace, "checklist", "add", { name: "Sample item" }));

    await expectDone(await move(KIM, world.kimsSpace, "checklist", { toSpaceId: world.family }));
    // As when she adds an app: an exception gives her edit, the owners have it, other members get nothing yet.
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(everything("checklist").access).toEqual([
      expect.objectContaining({ space_id: world.family, user_id: world.kim.id, level: "edit", created_by: world.kim.id }),
    ]);
    expect((await itemsOf(KIM, world.family)).map((item) => item.name)).toEqual(["Sample item"]);
    // Who first added it stays recorded.
    expect(everything("checklist").installs).toEqual([expect.objectContaining({ created_by: world.kim.id, created_at: NOW })]);
  });

  it("lets that member choose what the others get", async () => {
    install(world.db, world.kimsSpace, "checklist", world.kim.id);
    await expectDone(await move(KIM, world.kimsSpace, "checklist", { toSpaceId: world.family, memberAccess: "view" }));
    expect(await seenBy(KIM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([`${world.family}/checklist: view`]);
  });

  it("lets an owner move a personal app into the group, for the owners alone unless asked", async () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    await expectDone(await move(SAM, world.samsSpace, "checklist", { toSpaceId: world.family }));
    expect(await seenBy(SAM)).toEqual([`${world.family}/checklist: edit`]);
    expect(await seenBy(LIN)).toEqual([]);
    expect(await seenBy(KIM)).toEqual([]);
    // An owner needs no exception of their own.
    expect(everything("checklist").access).toEqual([]);
  });

  it("is for the owners of the space the app is in: a member gets 403 whatever she may do with it", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    const before = everything("checklist");
    // Kim may edit the app and add apps to the group; moving it out is still not hers to do.
    await expectError(await move(KIM, world.family, "checklist", { toSpaceId: world.kimsSpace }), 403, "forbidden");
    await expectError(await move(LIN, world.family, "checklist", { toSpaceId: world.linsSpace }), 403, "forbidden");
    // Before anything is said about the space it should go to.
    await expectError(await move(LIN, world.family, "checklist", { toSpaceId: "nowhere" }), 403, "forbidden");
    expect(everything("checklist")).toEqual(before);
  });

  it("needs the right to add apps where it goes: a plain member gets 403", async () => {
    install(world.db, world.linsSpace, "checklist", world.lin.id);
    const before = everything("checklist");
    await expectError(await move(LIN, world.linsSpace, "checklist", { toSpaceId: world.family }), 403, "forbidden");
    expect(everything("checklist")).toEqual(before);
  });

  it.each([
    ["a member it is hidden from", at(() => [LIN, world.family, "checklist", world.linsSpace])],
    ["someone who is not in the space", at(() => [NOA, world.family, "checklist", world.samsSpace])],
    ["an app the space does not have", at(() => [SAM, world.family, "feed", world.samsSpace])],
    ["an app the server does not hold", at(() => [SAM, world.family, "nothing", world.samsSpace])],
    ["a space that does not exist", at(() => [SAM, "nowhere", "checklist", world.samsSpace])],
    ["a space the mover is not in, as where it goes", at(() => [SAM, world.family, "checklist", world.linsSpace])],
    ["a space that does not exist, as where it goes", at(() => [SAM, world.family, "checklist", "nowhere"])],
  ] as const)("answers 404 for %s and moves nothing", async (_label, request) => {
    install(world.db, world.family, "checklist", world.sam.id);
    const before = everything("checklist");
    const [who, spaceId, appId, toSpaceId] = request();
    await expectError(await move(who, spaceId, appId, { toSpaceId }), 404, "not_found");
    expect(everything("checklist")).toEqual(before);
  });

  it("answers 404 for a removed app and one whose code is gone, also to an owner", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { removedAt: NOW });
    install(world.db, world.family, "feed", world.sam.id);
    const before = [everything("checklist"), everything("feed")];
    await expectError(await move(SAM, world.family, "checklist", { toSpaceId: world.samsSpace }), 404, "not_found");
    const withoutFeed = serverWith(APPS.filter((entry) => entry.id !== "feed"));
    await expectError(await move(SAM, world.family, "feed", { toSpaceId: world.samsSpace }, withoutFeed.app), 404, "not_found");
    expect([everything("checklist"), everything("feed")]).toEqual(before);
  });

  it("refuses a kind of space the app's manifest does not allow", async () => {
    install(world.db, world.samsSpace, "journal", world.sam.id);
    await expectError(await move(SAM, world.samsSpace, "journal", { toSpaceId: world.family }), 409, "conflict");
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/journal: edit`]);
  });

  it("does not let a member who may add apps move hers into a group that has the app hidden from her", async () => {
    install(world.db, world.family, "checklist", world.sam.id);
    install(world.db, world.kimsSpace, "checklist", world.kim.id);
    const before = everything("checklist");
    await expectError(await move(KIM, world.kimsSpace, "checklist", { toSpaceId: world.family }), 409, "conflict");
    expect(everything("checklist")).toEqual(before);
    expect(await seenBy(KIM)).toEqual([`${world.kimsSpace}/checklist: edit`]);
  });

  it.each([
    ["text that is not JSON", "{ toSpaceId: family"],
    ["no body at all", undefined],
    ["nothing", null],
    ["no space to go to", {}],
    ["an empty space ID", { toSpaceId: "" }],
    ["a level that does not exist", { toSpaceId: "family", memberAccess: "admin" }],
    ["a property the contract does not name", { toSpaceId: "family", pinned: true }],
  ])("refuses %s", async (_label, body) => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    const before = everything("checklist");
    await expectError(await call(SAM, "POST", `/api/spaces/${world.samsSpace}/apps/checklist/move`, body), 400, "invalid_request");
    expect(everything("checklist")).toEqual(before);
  });

  it("needs sign-in, and is refused from another site", async () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    const path = `/api/spaces/${world.samsSpace}/apps/checklist/move`;
    const body = { toSpaceId: world.family };
    await expectError(await call(null, "POST", path, body), 401, "unauthenticated");
    await expectError(await call("stranger@example.com", "POST", path, body), 403, "not_a_member");
    const crossSite = await app.request(`${BASE}${path}`, {
      method: "POST",
      headers: as(SAM, { "content-type": "application/json", origin: "https://evil.example.net" }),
      body: JSON.stringify(body),
    });
    await expectError(crossSite, 403, "invalid_request");
    expect(await seenBy(SAM)).toEqual([`${world.samsSpace}/checklist: edit`]);
  });

  it("logs nothing for a request it turns down", async () => {
    install(world.db, world.family, "checklist", world.sam.id);
    await move(LIN, world.family, "checklist", { toSpaceId: world.linsSpace });
    await move(SAM, world.family, "checklist", { toSpaceId: "nowhere" });
    await move(SAM, world.family, "checklist", { toSpaceId: world.family });
    expect(errors).toEqual([]);
  });
});

describe("after a move", () => {
  it("lets the space it left have the app again, empty", async () => {
    await aFamilyChecklist();
    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: world.samsSpace }));
    await expectDone(await call(SAM, "PUT", `/api/spaces/${world.family}/apps/checklist`, { memberAccess: "edit" }));
    expect(await itemsOf(LIN, world.family)).toEqual([]);
    expect(await settingsOf(LIN, world.family, "checklist")).toEqual({ space: { sections: [] }, user: { hideDone: false } });
    expect((await itemsOf(SAM, world.samsSpace)).length).toBe(2);
  });

  it("moves it back with its data, and what was deleted on the way stays deleted", async () => {
    await aFamilyChecklist();
    await expectDone(await move(SAM, world.family, "checklist", { toSpaceId: world.samsSpace }));
    await expectDone(await move(SAM, world.samsSpace, "checklist", { toSpaceId: world.family, memberAccess: "edit" }));

    expect((await itemsOf(LIN, world.family)).map((item) => item.name)).toEqual(["Sample item from Sam", "Sample item from Lin"]);
    // Lin's own setting and pin did not survive the time in Sam's own space.
    expect(await settingsOf(LIN, world.family, "checklist")).toEqual({ space: { sections: ["Garden", "House"] }, user: { hideDone: false } });
    expect(await appsOf(LIN)).toEqual([expect.objectContaining({ spaceId: world.family, access: "edit", pinned: false })]);
    expect(await appsOf(SAM)).toEqual([expect.objectContaining({ spaceId: world.family, pinned: true })]);
  });

  it("moves an app that keeps no rows and has no server file", async () => {
    install(world.db, world.samsSpace, "feed", world.sam.id);
    expect((await saveSettings(SAM, world.samsSpace, "feed", { user: { topics: ["food"] } })).status).toBe(200);
    setPrefs(world.db, world.samsSpace, "feed", world.sam.id, { enabled: true, pinned: true });

    await expectDone(await move(SAM, world.samsSpace, "feed", { toSpaceId: world.family, memberAccess: "view" }));
    expect(await appsOf(SAM)).toEqual([expect.objectContaining({ id: "feed", spaceId: world.family, pinned: true })]);
    expect((await settingsOf(SAM, world.family, "feed")).user).toEqual({ topics: ["food"], period: "day" });
    expect(await seenBy(LIN)).toEqual([`${world.family}/feed: view`]);
  });
});
