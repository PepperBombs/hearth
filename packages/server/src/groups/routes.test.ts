/**
 * Groups and the people in them, through the routes and as the session
 * shows them (docs/mini-app-contract.md, sections A6 "Groups and members"
 * and A8, and the owner's decisions 3 and 4): creating and renaming a
 * group, adding someone who is on the server or inviting someone who is
 * not, changing a member's role and right to add apps, removing a member,
 * leaving, and taking an invitation back.
 */
import {
  addMemberResponseSchema,
  apiErrorSchema,
  sessionSchema,
  spaceMemberSchema,
  spaceSchema,
  type ApiErrorCode,
  type Session,
} from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { install, APPS, family, grant, KIM, LIN, NOA, NOW, SAM, setPrefs } from "../apps/test-world";
import type { Config } from "../config";
import { hasInvitation } from "../db/people";
import { as, testApp, testConfig } from "../testing";

const BASE = "http://hearth.example.com";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

function serverWith(config: Config = testConfig()) {
  return testApp({ db: world.db, apps: APPS, config });
}

beforeEach(() => {
  world = family();
  ({ app, errors } = serverWith());
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

const createGroup = (who: string, body: unknown, on = app) => call(who, "POST", "/api/spaces", body, on);
const rename = (who: string, spaceId: string, body: unknown) => call(who, "PATCH", `/api/spaces/${spaceId}`, body);
const addMember = (who: string, spaceId: string, body: unknown, on = app) =>
  call(who, "POST", `/api/spaces/${spaceId}/members`, body, on);
const changeMember = (who: string, spaceId: string, memberId: string, body: unknown) =>
  call(who, "PATCH", `/api/spaces/${spaceId}/members/${memberId}`, body);
const removeMember = (who: string, spaceId: string, memberId: string) =>
  call(who, "DELETE", `/api/spaces/${spaceId}/members/${memberId}`);
const withdraw = (who: string, spaceId: string, email: string) =>
  call(who, "DELETE", `/api/spaces/${spaceId}/invitations`, { email });

async function expectDone(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

async function expectOutcome(response: Response, outcome: "added" | "invited") {
  expect(response.status).toBe(200);
  expect(addMemberResponseSchema.strict().parse(await response.json())).toEqual({ outcome });
}

async function sessionOf(who: string, on = app): Promise<Session> {
  const response = await call(who, "GET", "/api/session", undefined, on);
  expect(response.status).toBe(200);
  return sessionSchema.parse(await response.json());
}

/** The spaces a person's session lists, as "name: role" ("personal" for their own). */
async function spacesSeenBy(who: string): Promise<string[]> {
  return (await sessionOf(who)).spaces.map((space) => `${space.kind === "personal" ? "personal" : space.name}: ${space.role}`);
}

/** Who is in the family, as "email role" with "+apps" for a member who may add apps. */
const familyMembers = () =>
  (
    world.db
      .prepare(
        `SELECT u.email, m.role, m.can_add_apps AS canAddApps
           FROM space_members m JOIN users u ON u.id = m.user_id
          WHERE m.space_id = 'family' ORDER BY m.created_at, u.id`,
      )
      .all() as { email: string; role: string; canAddApps: number }[]
  ).map((row) => `${row.email} ${row.role}${row.canAddApps ? " +apps" : ""}`);

const spaceInvitations = () =>
  world.db
    .prepare("SELECT space_id AS spaceId, email, role, can_add_apps AS canAddApps, invited_by AS invitedBy FROM space_invitations ORDER BY space_id, email")
    .all();

const groupCount = () => (world.db.prepare("SELECT count(*) AS n FROM spaces WHERE kind = 'group'").get() as { n: number }).n;

describe("creating a group", () => {
  it("makes the server's owner its one owner and answers with it as the session lists it", async () => {
    const response = await createGroup(SAM, { name: "  Book club  " });
    expect(response.status).toBe(201);
    // Strict, so that a field the contract does not name would fail too.
    const space = spaceSchema
      .extend({ members: spaceMemberSchema.strict().array() })
      .strict()
      .parse(await response.json());
    expect(space).toEqual({
      id: expect.any(String),
      kind: "group",
      name: "Book club",
      role: "owner",
      canAddApps: true,
      members: [{ id: world.sam.id, name: world.sam.name, role: "owner" }],
    });
    // Groups come after the personal space, oldest first.
    expect((await sessionOf(SAM)).spaces.map((entry) => entry.name)).toEqual(["", "Family", "Book club"]);
    expect((await sessionOf(SAM)).spaces.at(-1)).toEqual(space);
    // Nobody else hears of it.
    expect(await spacesSeenBy(LIN)).toEqual(["personal: owner", "Family: member"]);
  });

  it("is the server's owner's alone, unless the server opens it to everyone", async () => {
    await expectError(await createGroup(LIN, { name: "Lin's friends" }), 403, "forbidden");
    expect(groupCount()).toBe(1);

    const open = serverWith(testConfig({ groupPolicy: "everyone" })).app;
    const response = await createGroup(LIN, { name: "Lin's friends" }, open);
    expect(response.status).toBe(201);
    expect(await spacesSeenBy(LIN)).toEqual(["personal: owner", "Family: member", "Lin's friends: owner"]);
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name that is too long", { name: "x".repeat(81) }],
    ["no name", {}],
    ["a property the contract does not name", { name: "Team", kind: "personal" }],
    ["text that is not JSON", "{ name: Team"],
  ])("refuses %s", async (_label, body) => {
    await expectError(await createGroup(SAM, body), 400, "invalid_request");
    expect(groupCount()).toBe(1);
  });

  it("needs sign-in", async () => {
    await expectError(await call(null, "POST", "/api/spaces", { name: "Team" }), 401, "unauthenticated");
    await expectError(await call("stranger@example.com", "POST", "/api/spaces", { name: "Team" }), 403, "not_a_member");
    expect(groupCount()).toBe(1);
  });
});

describe("renaming a group", () => {
  it("is for its owners, and everyone in the group sees the new name", async () => {
    await expectDone(await rename(SAM, world.family, { name: " The Examples " }));
    expect(await spacesSeenBy(LIN)).toEqual(["personal: owner", "The Examples: member"]);
    // Nothing to change is not an error.
    await expectDone(await rename(SAM, world.family, {}));
    expect(await spacesSeenBy(SAM)).toEqual(["personal: owner", "The Examples: owner"]);
  });

  it("is refused to a member, to anyone outside the group, and for a personal space", async () => {
    await expectError(await rename(LIN, world.family, { name: "Mine" }), 403, "forbidden");
    await expectError(await rename(NOA, world.family, { name: "Mine" }), 404, "not_found");
    await expectError(await rename(SAM, "nowhere", { name: "Mine" }), 404, "not_found");
    await expectError(await rename(SAM, world.samsSpace, { name: "Mine" }), 409, "conflict");
    await expectError(await rename(SAM, world.family, { name: "" }), 400, "invalid_request");
    expect(await spacesSeenBy(SAM)).toEqual(["personal: owner", "Family: owner"]);
  });
});

describe("adding someone who is on the server", () => {
  it("makes them a member at once, as a plain member who may not add apps unless asked", async () => {
    await expectOutcome(await addMember(SAM, world.family, { email: " Noa@Example.COM " }), "added");
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} member`, `${KIM} member +apps`, `${NOA} member`]);
    const noa = await sessionOf(NOA);
    expect(noa.spaces.map((space) => [space.name, space.role, space.canAddApps])).toEqual([
      ["", "owner", true],
      ["Family", "member", false],
    ]);
    // Everyone in the group sees them, last, by name.
    expect((await sessionOf(LIN)).spaces[1]?.members.at(-1)).toEqual({ id: world.noa.id, name: "noa", role: "member" });
  });

  it("may make them an owner, or a member who may add apps, from the start", async () => {
    await expectOutcome(await addMember(SAM, world.family, { email: NOA, role: "owner" }), "added");
    expect(familyMembers().at(-1)).toBe(`${NOA} owner`);
    await removeMember(SAM, world.family, world.noa.id);
    await expectOutcome(await addMember(SAM, world.family, { email: NOA, canAddApps: true }), "added");
    expect(familyMembers().at(-1)).toBe(`${NOA} member +apps`);
    expect((await sessionOf(NOA)).spaces[1]?.canAddApps).toBe(true);
  });

  it("is for any owner of the group, also one who is not the server's owner", async () => {
    await changeMember(SAM, world.family, world.lin.id, { role: "owner" });
    await expectOutcome(await addMember(LIN, world.family, { email: NOA }), "added");
    expect(familyMembers().at(-1)).toBe(`${NOA} member`);
  });

  it("is refused for someone who is already in the group", async () => {
    await expectError(await addMember(SAM, world.family, { email: LIN }), 409, "conflict");
    await expectError(await addMember(SAM, world.family, { email: SAM }), 409, "conflict");
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} member`, `${KIM} member +apps`]);
  });
});

describe("inviting someone who is not on the server yet", () => {
  const PAT = "pat@example.com";

  it("lets them in, and makes them a member with what was asked for when they first arrive", async () => {
    await expectOutcome(await addMember(SAM, world.family, { email: "Pat@Example.com", role: "member", canAddApps: true }), "invited");
    expect(spaceInvitations()).toEqual([{ spaceId: world.family, email: PAT, role: "member", canAddApps: 1, invitedBy: world.sam.id }]);
    expect(hasInvitation(world.db, PAT)).toBe(true);
    // Not a member until they arrive: the group lists the people in it.
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} member`, `${KIM} member +apps`]);

    const pat = await sessionOf(PAT);
    expect(pat.spaces.map((space) => [space.kind, space.name, space.role, space.canAddApps])).toEqual([
      ["personal", "", "owner", true],
      ["group", "Family", "member", true],
    ]);
    expect(familyMembers().at(-1)).toBe(`${PAT} member +apps`);
    // Both invitations are used up.
    expect(spaceInvitations()).toEqual([]);
    expect(hasInvitation(world.db, PAT)).toBe(false);
  });

  it("joins every group that invited them, as an owner where asked", async () => {
    const book = (await (await createGroup(SAM, { name: "Book club" })).json()) as { id: string };
    await expectOutcome(await addMember(SAM, world.family, { email: PAT }), "invited");
    await expectOutcome(await addMember(SAM, book.id, { email: PAT, role: "owner" }), "invited");
    expect(await spacesSeenBy(PAT)).toEqual(["personal: owner", "Family: member", "Book club: owner"]);
  });

  it("is refused to a group owner who is not the server's owner, unless the server opens it to everyone", async () => {
    await changeMember(SAM, world.family, world.lin.id, { role: "owner" });
    await expectError(await addMember(LIN, world.family, { email: PAT }), 403, "forbidden");
    expect(spaceInvitations()).toEqual([]);
    expect(hasInvitation(world.db, PAT)).toBe(false);
    await expectError(await call(PAT, "GET", "/api/session"), 403, "not_a_member");

    const open = serverWith(testConfig({ groupPolicy: "everyone" })).app;
    await expectOutcome(await addMember(LIN, world.family, { email: PAT }, open), "invited");
    expect(await spacesSeenBy(PAT)).toEqual(["personal: owner", "Family: member"]);
  });

  it("is refused for an address already invited to the group", async () => {
    await addMember(SAM, world.family, { email: PAT });
    await expectError(await addMember(SAM, world.family, { email: "PAT@example.com", role: "owner" }), 409, "conflict");
    expect(spaceInvitations()).toEqual([expect.objectContaining({ email: PAT, role: "member" })]);
  });

  it.each([
    ["text that is not an address", "pat"],
    ["an address with a character that only looks like a letter", "paKt@example.com"],
  ])("refuses %s", async (_label, email) => {
    await expectError(await addMember(SAM, world.family, { email }), 400, "invalid_request");
    expect(spaceInvitations()).toEqual([]);
  });
});

describe("who may add people", () => {
  it.each([
    ["a member, even one who may add apps", KIM, (): string => world.family, 403, "forbidden"],
    ["someone outside the group", NOA, (): string => world.family, 404, "not_found"],
    ["anyone, to a space that does not exist", SAM, (): string => "nowhere", 404, "not_found"],
    ["the owner of a personal space, which is for one person", SAM, (): string => world.samsSpace, 409, "conflict"],
  ] as const)("not %s", async (_label, who, space, status, code) => {
    await expectError(await addMember(who, space(), { email: NOA }), status, code);
    await expectError(await addMember(who, space(), { email: "pat@example.com" }), status, code);
    expect(spaceInvitations()).toEqual([]);
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} member`, `${KIM} member +apps`]);
  });

  it.each([
    ["no address", {}],
    ["an empty address", { email: "" }],
    ["a role that does not exist", { email: NOA, role: "admin" }],
    ["a property the contract does not name", { email: NOA, spaceId: "nowhere" }],
  ])("refuses %s", async (_label, body) => {
    await expectError(await addMember(SAM, world.family, body), 400, "invalid_request");
    expect(familyMembers()).toHaveLength(3);
  });
});

describe("changing a member", () => {
  it("lets an owner make a member an owner, and allow or stop them adding apps", async () => {
    await expectDone(await changeMember(SAM, world.family, world.lin.id, { canAddApps: true }));
    expect((await sessionOf(LIN)).spaces[1]).toMatchObject({ role: "member", canAddApps: true });
    await expectDone(await changeMember(SAM, world.family, world.lin.id, { role: "owner", canAddApps: false }));
    expect((await sessionOf(LIN)).spaces[1]).toMatchObject({ role: "owner", canAddApps: true });
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} owner`, `${KIM} member +apps`]);
    // What is left out stays as it is.
    await expectDone(await changeMember(SAM, world.family, world.kim.id, {}));
    await expectDone(await changeMember(SAM, world.family, world.kim.id, { role: "member" }));
    expect(familyMembers().at(-1)).toBe(`${KIM} member +apps`);
  });

  it("lets the new owner manage the group, and an owner step down while another remains", async () => {
    await changeMember(SAM, world.family, world.lin.id, { role: "owner" });
    await expectDone(await changeMember(LIN, world.family, world.kim.id, { canAddApps: false }));
    await expectDone(await changeMember(SAM, world.family, world.sam.id, { role: "member" }));
    expect(familyMembers()).toEqual([`${SAM} member`, `${LIN} owner`, `${KIM} member`]);
    await expectError(await changeMember(SAM, world.family, world.kim.id, { role: "owner" }), 403, "forbidden");
  });

  it("never leaves a group without an owner", async () => {
    await expectError(await changeMember(SAM, world.family, world.sam.id, { role: "member" }), 409, "conflict");
    expect(familyMembers()[0]).toBe(`${SAM} owner`);
    // Nothing of a refused request is kept, the part that was allowed included.
    await expectError(await changeMember(SAM, world.family, world.sam.id, { role: "member", canAddApps: true }), 409, "conflict");
    expect(familyMembers()[0]).toBe(`${SAM} owner`);
  });

  it("keeps the exceptions made for a member while they are an owner, and applies them again after", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    grant(world.db, world.family, "checklist", world.lin.id, "none", world.sam.id);
    expect((await sessionOf(LIN)).apps).toEqual([]);
    await changeMember(SAM, world.family, world.lin.id, { role: "owner" });
    expect((await sessionOf(LIN)).apps.map((entry) => entry.access)).toEqual(["edit"]);
    await changeMember(SAM, world.family, world.lin.id, { role: "member" });
    expect((await sessionOf(LIN)).apps).toEqual([]);
  });

  it.each([
    ["a member", KIM, (): string => world.family, (): string => world.lin.id, 403, "forbidden"],
    ["someone outside the group", NOA, (): string => world.family, (): string => world.lin.id, 404, "not_found"],
    ["an owner, about someone outside the group", SAM, (): string => world.family, (): string => world.noa.id, 404, "not_found"],
    ["an owner, about nobody", SAM, (): string => world.family, (): string => "nobody", 404, "not_found"],
    ["the owner of a personal space", SAM, (): string => world.samsSpace, (): string => world.sam.id, 409, "conflict"],
  ] as const)("is refused to %s", async (_label, who, space, member, status, code) => {
    await expectError(await changeMember(who, space(), member(), { canAddApps: true }), status, code);
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} member`, `${KIM} member +apps`]);
  });

  it.each([
    ["a role that does not exist", { role: "admin" }],
    ["a right that is not a switch", { canAddApps: 1 }],
    ["a property the contract does not name", { name: "Lin" }],
  ])("refuses %s", async (_label, body) => {
    await expectError(await changeMember(SAM, world.family, world.lin.id, body), 400, "invalid_request");
  });
});

describe("removing a member, and leaving", () => {
  it("takes the member out with their access, switches, pins and own settings, and keeps the rows they wrote", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
    grant(world.db, world.family, "checklist", world.lin.id, "edit", world.sam.id);
    setPrefs(world.db, world.family, "checklist", world.lin.id, { enabled: true, pinned: true });
    world.db
      .prepare(
        `INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at)
         VALUES ('family', 'checklist', ?, '{"hideDone":true}', ?, ?, ?)`,
      )
      .run(world.lin.id, world.lin.id, world.lin.id, NOW);
    world.db
      .prepare(
        `INSERT INTO app_rows (id, space_id, app_id, collection, data, created_by, updated_by, created_at, updated_at)
         VALUES ('row-1', 'family', 'checklist', 'items', '{"name":"Milk","section":"","done":false}', ?, ?, ?, ?)`,
      )
      .run(world.lin.id, world.lin.id, NOW, NOW);
    const about = (table: string) =>
      (world.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = 'family' AND user_id = ?`).get(world.lin.id) as { n: number }).n;
    expect([about("app_access"), about("app_prefs"), about("app_settings")]).toEqual([1, 1, 1]);

    await expectDone(await removeMember(SAM, world.family, world.lin.id));
    expect(await spacesSeenBy(LIN)).toEqual(["personal: owner"]);
    expect((await sessionOf(LIN)).apps).toEqual([]);
    expect([about("app_access"), about("app_prefs"), about("app_settings")]).toEqual([0, 0, 0]);
    await expectError(await call(LIN, "POST", `/api/spaces/${world.family}/apps/checklist/q/list`, {}), 404, "not_found");
    // The row Lin added belongs to the group.
    const list = await call(SAM, "POST", `/api/spaces/${world.family}/apps/checklist/q/list`, {});
    expect(((await list.json()) as { output: { name: string; createdBy: string }[] }).output).toEqual([
      expect.objectContaining({ name: "Milk", createdBy: world.lin.id }),
    ]);
  });

  it("lets anyone leave a group, and an owner remove another owner", async () => {
    await expectDone(await removeMember(KIM, world.family, world.kim.id));
    await changeMember(SAM, world.family, world.lin.id, { role: "owner" });
    await expectDone(await removeMember(LIN, world.family, world.sam.id));
    expect(familyMembers()).toEqual([`${LIN} owner`]);
  });

  it("never leaves a group without an owner", async () => {
    await expectError(await removeMember(SAM, world.family, world.sam.id), 409, "conflict");
    expect(familyMembers()[0]).toBe(`${SAM} owner`);
  });

  it.each([
    ["a member, about someone else", KIM, (): string => world.family, (): string => world.lin.id, 403, "forbidden"],
    ["someone outside the group", NOA, (): string => world.family, (): string => world.lin.id, 404, "not_found"],
    ["someone outside the group, about themselves", NOA, (): string => world.family, (): string => world.noa.id, 404, "not_found"],
    ["an owner, about someone outside the group", SAM, (): string => world.family, (): string => world.noa.id, 404, "not_found"],
    ["the owner of a personal space, leaving it", SAM, (): string => world.samsSpace, (): string => world.sam.id, 409, "conflict"],
  ] as const)("is refused to %s", async (_label, who, space, member, status, code) => {
    await expectError(await removeMember(who, space(), member()), status, code);
    expect(familyMembers()).toEqual([`${SAM} owner`, `${LIN} member`, `${KIM} member +apps`]);
    expect(await spacesSeenBy(SAM)).toEqual(["personal: owner", "Family: owner"]);
  });
});

describe("taking an invitation back", () => {
  const PAT = "pat@example.com";

  it("is for the group's owners, and stops the person getting in when it was their only one", async () => {
    await addMember(SAM, world.family, { email: PAT });
    await expectError(await withdraw(LIN, world.family, PAT), 403, "forbidden");
    await expectError(await withdraw(NOA, world.family, PAT), 404, "not_found");
    await expectDone(await withdraw(SAM, world.family, " Pat@Example.com "));
    expect(spaceInvitations()).toEqual([]);
    expect(hasInvitation(world.db, PAT)).toBe(false);
    await expectError(await call(PAT, "GET", "/api/session"), 403, "not_a_member");
  });

  it("leaves the person's invitations to other groups, and with them their way in", async () => {
    const book = (await (await createGroup(SAM, { name: "Book club" })).json()) as { id: string };
    await addMember(SAM, world.family, { email: PAT });
    await addMember(SAM, book.id, { email: PAT });
    await expectDone(await withdraw(SAM, world.family, PAT));
    expect(hasInvitation(world.db, PAT)).toBe(true);
    expect(await spacesSeenBy(PAT)).toEqual(["personal: owner", "Book club: member"]);
  });

  it("answers 404 for an address the group has not invited", async () => {
    await expectError(await withdraw(SAM, world.family, PAT), 404, "not_found");
    await expectError(await withdraw(SAM, world.family, "not an address"), 404, "not_found");
    await expectError(await withdraw(SAM, world.samsSpace, PAT), 409, "conflict");
    await expectError(await call(SAM, "DELETE", `/api/spaces/${world.family}/invitations`, {}), 400, "invalid_request");
  });
});

it("logs nothing for the requests it turns down", async () => {
  await createGroup(LIN, { name: "Mine" });
  await addMember(KIM, world.family, { email: NOA });
  await changeMember(SAM, world.family, world.sam.id, { role: "member" });
  await removeMember(SAM, world.family, world.sam.id);
  await withdraw(SAM, world.family, "pat@example.com");
  expect(errors).toEqual([]);
});
