/**
 * What an assistant may do, as a space's owners decide it
 * (docs/mini-app-contract.md, section F, "The switches", build step F1):
 * the space's level, an app left out, and what that leaves for each person,
 * worked out in VISIBLE and checked again inside callApp's transaction.
 */
import { apiErrorSchema, sessionSchema, type ApiErrorCode, type MemberAccess } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { callApp } from "../apps/calls";
import { resolveInstall, type Caller } from "../apps/installs";
import { createRegistry, type Registry } from "../apps/registry";
import { APPS, family, grant, install, KIM, LIN, NOA, SAM } from "../apps/test-world";
import { as, testApp } from "../testing";

const BASE = "http://hearth.example.com";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let registry: Registry;

beforeEach(() => {
  world = family();
  ({ app } = testApp({ db: world.db, apps: APPS }));
  registry = createRegistry(APPS);
});

function call(who: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = as(who);
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const setLevel = (who: string, spaceId: string, level: unknown) =>
  call(who, "PUT", `/api/spaces/${spaceId}/assistant`, { level });
const setAccess = (who: string, spaceId: string, appId: string, body: unknown) =>
  call(who, "PUT", `/api/spaces/${spaceId}/apps/${appId}/access`, body);

async function expectDone(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

const levelIn = (spaceId: string) =>
  (world.db.prepare("SELECT assistant FROM spaces WHERE id = ?").get(spaceId) as { assistant: MemberAccess }).assistant;
const includedIn = (spaceId: string, appId: string) =>
  (world.db.prepare("SELECT assistant FROM space_apps WHERE space_id = ? AND app_id = ?").get(spaceId, appId) as { assistant: 0 | 1 })
    .assistant;
const setLevelDirectly = (spaceId: string, level: MemberAccess) =>
  world.db.prepare("UPDATE spaces SET assistant = ? WHERE id = ?").run(level, spaceId);

/** What someone in the world may do with the family's checklist, by themselves or through an assistant. */
const levelOf = (userId: string, by: Caller, appId = "checklist", spaceId = world.family) =>
  resolveInstall(world.db, registry, userId, spaceId, appId, by);

async function sessionLevels(who: string): Promise<Record<string, MemberAccess>> {
  const response = await call(who, "GET", "/api/session");
  expect(response.status).toBe(200);
  const session = sessionSchema.parse(await response.json());
  return Object.fromEntries(session.spaces.map((space) => [space.id, space.assistant]));
}

describe("what an assistant may do with an app for a person", () => {
  beforeEach(() => {
    // Every member may view the checklist; Kim may edit it; Noa is not in the family.
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
    grant(world.db, world.family, "checklist", world.kim.id, "edit", world.sam.id);
  });

  it("is nothing while the space is Off, whatever the person may do", () => {
    expect(levelIn(world.family)).toBe("none");
    for (const person of [world.sam, world.lin, world.kim, world.noa]) {
      expect(levelOf(person.id, "assistant"), person.email).toBeNull();
    }
    // The person themselves keeps what they had.
    expect([world.sam, world.lin, world.kim, world.noa].map((person) => levelOf(person.id, "person"))).toEqual([
      "edit",
      "view",
      "edit",
      null,
    ]);
  });

  it("is at most viewing while the space is Read only", () => {
    setLevelDirectly(world.family, "view");
    expect([world.sam, world.lin, world.kim, world.noa].map((person) => levelOf(person.id, "assistant"))).toEqual([
      "view",
      "view",
      "view",
      null,
    ]);
  });

  it("is what the person may do while the space is Read and change", () => {
    setLevelDirectly(world.family, "edit");
    expect([world.sam, world.lin, world.kim, world.noa].map((person) => levelOf(person.id, "assistant"))).toEqual([
      "edit",
      "view",
      "edit",
      null,
    ]);
  });

  it("is nothing for someone with no access, and for an app left out, at any level", () => {
    setLevelDirectly(world.family, "edit");
    grant(world.db, world.family, "checklist", world.lin.id, "none", world.sam.id);
    expect(levelOf(world.lin.id, "assistant")).toBeNull();
    world.db.prepare("UPDATE space_apps SET assistant = 0 WHERE space_id = ? AND app_id = 'checklist'").run(world.family);
    expect([world.sam, world.kim].map((person) => levelOf(person.id, "assistant"))).toEqual([null, null]);
    // Leaving an app out changes nothing for the people themselves.
    expect([world.sam, world.kim].map((person) => levelOf(person.id, "person"))).toEqual(["edit", "edit"]);
  });

  it("is nothing for an app that was removed or whose code the server does not hold", () => {
    setLevelDirectly(world.family, "edit");
    install(world.db, world.family, "retired", world.sam.id, { memberAccess: "edit" });
    install(world.db, world.family, "feed", world.sam.id, { memberAccess: "edit", removedAt: "2026-01-05T00:00:00.000Z" });
    expect(levelOf(world.sam.id, "assistant", "retired")).toBeNull();
    expect(levelOf(world.sam.id, "assistant", "feed")).toBeNull();
  });

  it("follows each space's own level: a personal space is its owner's to switch", () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    setLevelDirectly(world.family, "edit");
    expect(levelOf(world.sam.id, "assistant", "checklist", world.samsSpace)).toBeNull();
    setLevelDirectly(world.samsSpace, "view");
    expect(levelOf(world.sam.id, "assistant", "checklist", world.samsSpace)).toBe("view");
  });
});

describe("PUT /api/spaces/:spaceId/assistant", () => {
  it("lets an owner set the level, which every member then sees in the session", async () => {
    await expectDone(await setLevel(SAM, world.family, "view"));
    expect(levelIn(world.family)).toBe("view");
    expect((await sessionLevels(LIN))[world.family]).toBe("view");
    await expectDone(await setLevel(SAM, world.family, "edit"));
    await expectDone(await setLevel(SAM, world.family, "edit"));
    expect((await sessionLevels(KIM))[world.family]).toBe("edit");
    await expectDone(await setLevel(SAM, world.family, "none"));
    expect((await sessionLevels(SAM))[world.family]).toBe("none");
  });

  it("lets everyone switch their own personal space, and starts every space Off", async () => {
    expect(await sessionLevels(LIN)).toEqual({ [world.linsSpace]: "none", [world.family]: "none" });
    await expectDone(await setLevel(LIN, world.linsSpace, "edit"));
    expect(await sessionLevels(LIN)).toEqual({ [world.linsSpace]: "edit", [world.family]: "none" });
  });

  it("refuses a member, anyone outside the space, and a level that is not one", async () => {
    await expectError(await setLevel(KIM, world.family, "edit"), 403, "forbidden");
    await expectError(await setLevel(NOA, world.family, "edit"), 404, "not_found");
    await expectError(await setLevel(SAM, world.linsSpace, "edit"), 404, "not_found");
    await expectError(await setLevel(SAM, "nowhere", "edit"), 404, "not_found");
    for (const level of ["admin", "", null, 1]) {
      await expectError(await setLevel(SAM, world.family, level), 400, "invalid_request");
    }
    await expectError(await call(SAM, "PUT", `/api/spaces/${world.family}/assistant`, { level: "view", app: "checklist" }), 400, "invalid_request");
    expect(levelIn(world.family)).toBe("none");
    expect(levelIn(world.linsSpace)).toBe("none");
  });
});

describe("leaving an app out through the access route", () => {
  beforeEach(() => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    setLevelDirectly(world.family, "edit");
  });

  it("lets an owner leave an app out and take it back in, keeping the rest as it was", async () => {
    await expectDone(await setAccess(SAM, world.family, "checklist", { assistant: false }));
    expect(includedIn(world.family, "checklist")).toBe(0);
    expect(levelOf(world.lin.id, "assistant")).toBeNull();
    expect(levelOf(world.lin.id, "person")).toBe("edit");
    await expectDone(await setAccess(SAM, world.family, "checklist", { assistant: true, memberAccess: "view" }));
    expect(includedIn(world.family, "checklist")).toBe(1);
    expect(levelOf(world.lin.id, "assistant")).toBe("view");
  });

  it("refuses a member and anyone outside, and changes nothing then", async () => {
    await expectError(await setAccess(KIM, world.family, "checklist", { assistant: false }), 403, "forbidden");
    await expectError(await setAccess(NOA, world.family, "checklist", { assistant: false }), 404, "not_found");
    await expectError(await setAccess(SAM, world.family, "checklist", { assistant: "no" }), 400, "invalid_request");
    expect(includedIn(world.family, "checklist")).toBe(1);
  });
});

describe("moving an app and bringing one back", () => {
  it("includes the app again where it goes, under that space's level", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    world.db.prepare("UPDATE space_apps SET assistant = 0 WHERE space_id = ? AND app_id = 'checklist'").run(world.family);
    setLevelDirectly(world.samsSpace, "edit");
    const response = await call(SAM, "POST", `/api/spaces/${world.family}/apps/checklist/move`, { toSpaceId: world.samsSpace });
    await expectDone(response);
    expect(includedIn(world.samsSpace, "checklist")).toBe(1);
    expect(levelOf(world.sam.id, "assistant", "checklist", world.samsSpace)).toBe("edit");
  });

  it("includes an app brought back, as access starts afresh", async () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view", removedAt: "2026-01-05T00:00:00.000Z" });
    world.db.prepare("UPDATE space_apps SET assistant = 0 WHERE space_id = ? AND app_id = 'checklist'").run(world.family);
    await expectDone(await call(SAM, "PUT", `/api/spaces/${world.family}/apps/checklist`, { memberAccess: "view" }));
    expect(includedIn(world.family, "checklist")).toBe(1);
  });
});

describe("a call by an assistant", () => {
  beforeEach(() => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
  });

  const rows = () => (world.db.prepare("SELECT count(*) AS n FROM app_rows WHERE space_id = 'family'").get() as { n: number }).n;
  const add = (by: Caller) =>
    callApp(world.db, registry, {
      user: world.sam,
      spaceId: world.family,
      appId: "checklist",
      kind: "mutation",
      name: "add",
      input: { name: "Milk" },
      by,
    });
  const list = (by: Caller) =>
    callApp(world.db, registry, {
      user: world.sam,
      spaceId: world.family,
      appId: "checklist",
      kind: "query",
      name: "list",
      input: undefined,
      by,
    });

  it("is not there while the space is Off, as for an app that does not exist", () => {
    expect(() => list("assistant")).toThrow(expect.objectContaining({ status: 404, code: "not_found" }));
    expect(JSON.parse(list("person"))).toEqual({ output: [] });
  });

  it("may read but not change while the space is Read only, and changes nothing", () => {
    setLevelDirectly(world.family, "view");
    expect(JSON.parse(list("assistant"))).toEqual({ output: [] });
    expect(() => add("assistant")).toThrow(expect.objectContaining({ status: 403, code: "forbidden" }));
    expect(rows()).toBe(0);
  });

  it("changes data while the space is Read and change, as the person", () => {
    setLevelDirectly(world.family, "edit");
    expect(JSON.parse(add("assistant"))).toEqual({ output: expect.objectContaining({ name: "Milk" }) });
    expect(rows()).toBe(1);
    expect(world.db.prepare("SELECT created_by AS by FROM app_rows").get()).toEqual({ by: world.sam.id });
  });
});
