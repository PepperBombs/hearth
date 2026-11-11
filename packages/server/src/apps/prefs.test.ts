/**
 * Each person's own switch and pin for an app in a space:
 * PATCH /api/spaces/:spaceId/apps/:appId/me (docs/mini-app-contract.md,
 * sections A6 "Enable and pin" and A8).
 */
import { apiErrorSchema, sessionSchema, type ApiErrorCode } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { as, testApp } from "../testing";
import { APPS, family, grant, install, KIM, LIN, NOA, NOW, SAM, setPrefs } from "./test-world";

const BASE = "http://hearth.example.com";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];

beforeEach(() => {
  world = family();
  ({ app } = testApp({ db: world.db, apps: APPS }));
  install(world.db, world.samsSpace, "checklist", world.sam.id);
  // Lin may look at the family's checklist; Kim may change it.
  install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
  grant(world.db, world.family, "checklist", world.kim.id, "edit", world.sam.id);
});

/** Who asks about which app in which space; made when the test runs, once the world exists. */
const at = (request: () => [who: string, spaceId: string, appId: string]) => request;

function patchMe(who: string, spaceId: string, appId: string, body: unknown) {
  return app.request(`${BASE}/api/spaces/${spaceId}/apps/${appId}/me`, {
    method: "PATCH",
    headers: { ...as(who), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectDone(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

/** What a person's session says about their own switch and pin, as "space/app: on|off pinned?". */
async function prefsSeenBy(who: string): Promise<string[]> {
  const response = await app.request(`${BASE}/api/session`, { headers: as(who) });
  expect(response.status).toBe(200);
  return sessionSchema
    .parse(await response.json())
    .apps.map((entry) => `${entry.spaceId}/${entry.id}: ${entry.enabled ? "on" : "off"}${entry.pinned ? " pinned" : ""}`);
}

const prefsRows = () =>
  world.db
    .prepare(
      `SELECT space_id AS spaceId, app_id AS appId, user_id AS userId, enabled, pinned
         FROM app_prefs ORDER BY space_id, app_id, user_id`,
    )
    .all();

describe("a person's own switch and pin", () => {
  it("switches an app off and on again, and pins it, for the caller alone", async () => {
    await expectDone(await patchMe(SAM, world.samsSpace, "checklist", { enabled: false }));
    expect(await prefsSeenBy(SAM)).toEqual([`${world.samsSpace}/checklist: off`, `${world.family}/checklist: on`]);

    await expectDone(await patchMe(SAM, world.samsSpace, "checklist", { pinned: true }));
    // What the patch leaves out stays as it was.
    expect(await prefsSeenBy(SAM)).toEqual([`${world.samsSpace}/checklist: off pinned`, `${world.family}/checklist: on`]);

    await expectDone(await patchMe(SAM, world.samsSpace, "checklist", { enabled: true, pinned: false }));
    expect(await prefsSeenBy(SAM)).toEqual([`${world.samsSpace}/checklist: on`, `${world.family}/checklist: on`]);
  });

  it("is each person's own in a group, and view access is enough", async () => {
    await expectDone(await patchMe(LIN, world.family, "checklist", { enabled: false, pinned: true }));
    await expectDone(await patchMe(KIM, world.family, "checklist", { pinned: true }));

    expect(await prefsSeenBy(LIN)).toEqual([`${world.family}/checklist: off pinned`]);
    expect(await prefsSeenBy(KIM)).toEqual([`${world.family}/checklist: on pinned`]);
    expect(await prefsSeenBy(SAM)).toEqual([`${world.samsSpace}/checklist: on`, `${world.family}/checklist: on`]);
    expect(prefsRows()).toEqual([
      { spaceId: world.family, appId: "checklist", userId: world.lin.id, enabled: 0, pinned: 1 },
      { spaceId: world.family, appId: "checklist", userId: world.kim.id, enabled: 1, pinned: 1 },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
  });

  it("changes nobody's access, the caller's included", async () => {
    const access = () => world.db.prepare("SELECT * FROM app_access ORDER BY user_id").all();
    const installs = () => world.db.prepare("SELECT * FROM space_apps ORDER BY space_id").all();
    const before = [access(), installs()];
    await expectDone(await patchMe(LIN, world.family, "checklist", { enabled: false }));
    expect([access(), installs()]).toEqual(before);
  });

  it("writes nothing for an empty patch", async () => {
    await expectDone(await patchMe(SAM, world.samsSpace, "checklist", {}));
    expect(prefsRows()).toEqual([]);
  });

  it("keeps an existing row's other value", async () => {
    setPrefs(world.db, world.samsSpace, "checklist", world.sam.id, { enabled: false, pinned: true });
    await expectDone(await patchMe(SAM, world.samsSpace, "checklist", { enabled: true }));
    expect(prefsRows()).toEqual([
      { spaceId: world.samsSpace, appId: "checklist", userId: world.sam.id, enabled: 1, pinned: 1 },
    ]);
  });

  it.each([
    ["someone else's personal space", at(() => [LIN, world.samsSpace, "checklist"])],
    ["a group the person is not in", at(() => [NOA, world.family, "checklist"])],
    ["an app the space does not have", at(() => [SAM, world.samsSpace, "journal"])],
    ["an app the server does not hold", at(() => [SAM, world.samsSpace, "nothing"])],
    ["a space that does not exist", at(() => [SAM, "nowhere", "checklist"])],
  ] as const)("answers 404 for %s and writes nothing", async (_label, request) => {
    const [who, spaceId, appId] = request();
    await expectError(await patchMe(who, spaceId, appId, { pinned: true }), 404, "not_found");
    expect(prefsRows()).toEqual([]);
  });

  it("answers 404 to a member whose access is none, and to anyone for a removed app", async () => {
    grant(world.db, world.family, "checklist", world.lin.id, "none", world.sam.id);
    await expectError(await patchMe(LIN, world.family, "checklist", { pinned: true }), 404, "not_found");

    world.db.prepare("UPDATE space_apps SET removed_at = ? WHERE space_id = ?").run(NOW, world.samsSpace);
    await expectError(await patchMe(SAM, world.samsSpace, "checklist", { pinned: true }), 404, "not_found");
    expect(prefsRows()).toEqual([]);
  });

  it.each([
    ["text that is not JSON", "{ pinned: yes"],
    ["a value that is not a switch", { enabled: "no" }],
    ["a property the contract does not name", { pinned: true, order: 1 }],
    ["a list", []],
  ] as const)("answers 400 for %s", async (_label, body) => {
    await expectError(await patchMe(SAM, world.samsSpace, "checklist", body), 400, "invalid_request");
    expect(prefsRows()).toEqual([]);
  });

  it("checks the body before the app, as the other routes do", async () => {
    await expectError(await patchMe(NOA, world.family, "checklist", { pinned: "yes" }), 400, "invalid_request");
  });
});
