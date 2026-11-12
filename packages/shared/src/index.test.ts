import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  addAppRequestSchema,
  addMemberRequestSchema,
  addMemberResponseSchema,
  apiErrorSchema,
  appAccessRequestSchema,
  appCallRequestSchema,
  appCallResponseSchema,
  appPrefsPatchSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  appSummarySchema,
  createSpaceRequestSchema,
  deleteAppDataRequestSchema,
  JOB_STATES,
  jobStateOf,
  jobStatusSchema,
  memberPatchSchema,
  moveAppRequestSchema,
  sessionSchema,
  spaceAppsSchema,
  spacePatchSchema,
  spaceSchema,
  withdrawInvitationRequestSchema,
  type Session,
} from "./index";

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const app: Session["apps"][number] = {
  id: "checklist",
  spaceId: "space-1",
  name: { en: "Checklist", zh: "清单" },
  description: { en: "A sample list.", zh: "示例清单。" },
  icon: "list-checks",
  color: "green",
  widgetSize: "tall",
  access: "view",
  enabled: true,
  pinned: false,
  hasPage: true,
};

const space: Session["spaces"][number] = {
  id: "space-1",
  kind: "group",
  name: "Family",
  role: "member",
  canAddApps: false,
  members: [
    { id: "user-1", name: "Sam Example", role: "owner" },
    { id: "user-2", name: "Lin Example", role: "member" },
  ],
};

const session: Session = {
  user: { id: "user-2", email: "lin@example.com", name: "Lin Example", locale: "zh", theme: "system" },
  spaces: [space],
  apps: [app],
  canCreateGroups: false,
  canInvitePeople: false,
  version: "a1b2c3d",
};

const without = <T extends object>(value: T, key: keyof T) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

describe("the session", () => {
  it("accepts a full session and returns it unchanged", () => {
    expect(sessionSchema.parse(session)).toEqual(session);
  });

  it.each(["canCreateGroups", "canInvitePeople", "spaces", "apps"] as const)(
    "needs %s",
    (key) => {
      expect(accepts(sessionSchema, without(session, key))).toBe(false);
    },
  );

  it.each(["widgetSize", "access", "enabled", "pinned", "hasPage"] as const)(
    "needs %s on every app",
    (key) => {
      expect(accepts(appSummarySchema, without(app, key))).toBe(false);
    },
  );

  it("knows two levels of access to an app; an app without access is not listed", () => {
    expect(accepts(appSummarySchema, { ...app, access: "edit" })).toBe(true);
    expect(accepts(appSummarySchema, { ...app, access: "none" })).toBe(false);
    expect(accepts(appSummarySchema, { ...app, access: "owner" })).toBe(false);
  });

  it("knows the four card sizes", () => {
    for (const widgetSize of ["small", "wide", "tall", "large"]) {
      expect(accepts(appSummarySchema, { ...app, widgetSize })).toBe(true);
    }
    expect(accepts(appSummarySchema, { ...app, widgetSize: "huge" })).toBe(false);
  });

  it.each(["canAddApps", "members", "role"] as const)("needs %s on every space", (key) => {
    expect(accepts(spaceSchema, without(space, key))).toBe(false);
  });

  it("gives each member a role, and lets a space have several owners", () => {
    const twoOwners = { ...space, members: space.members.map((m) => ({ ...m, role: "owner" })) };
    expect(accepts(spaceSchema, twoOwners)).toBe(true);
    expect(accepts(spaceSchema, { ...space, members: [{ id: "user-1", name: "Sam Example" }] })).toBe(false);
    expect(accepts(spaceSchema, { ...space, members: [{ id: "user-1", name: "Sam", role: "guest" }] })).toBe(false);
  });

  it("drops what it does not name, such as a member's email address", () => {
    const parsed = spaceSchema.parse({
      ...space,
      members: [{ id: "user-1", name: "Sam Example", role: "owner", email: "sam@example.com" }],
    });
    expect(parsed.members[0]).toEqual({ id: "user-1", name: "Sam Example", role: "owner" });
  });
});

describe("error codes", () => {
  it("include forbidden and conflict", () => {
    expect(API_ERROR_CODES).toEqual(
      expect.arrayContaining(["unauthenticated", "not_a_member", "forbidden", "invalid_request", "not_found", "conflict", "internal"]),
    );
    expect(API_ERROR_CODES).toHaveLength(7);
    for (const code of ["forbidden", "conflict"]) {
      expect(accepts(apiErrorSchema, { error: { code, message: "Sample failure" } })).toBe(true);
    }
    expect(accepts(apiErrorSchema, { error: { code: "teapot", message: "Sample failure" } })).toBe(false);
  });
});

describe("request bodies", () => {
  it("refuse a property they do not know", () => {
    const cases: [{ safeParse(value: unknown): { success: boolean } }, object][] = [
      [createSpaceRequestSchema, { name: "Family" }],
      [spacePatchSchema, { name: "Family" }],
      [addMemberRequestSchema, { email: "lin@example.com" }],
      [memberPatchSchema, { canAddApps: true }],
      [withdrawInvitationRequestSchema, { email: "kim@example.com" }],
      [addAppRequestSchema, { memberAccess: "view" }],
      [deleteAppDataRequestSchema, { confirm: "checklist" }],
      [moveAppRequestSchema, { toSpaceId: "space-2" }],
      [appAccessRequestSchema, { memberAccess: "edit" }],
      [appPrefsPatchSchema, { pinned: true }],
      [appSettingsPatchSchema, { user: { hideDone: true } }],
      [appCallRequestSchema, { input: { id: "row-1" } }],
    ];
    for (const [schema, body] of cases) {
      expect(accepts(schema, body), JSON.stringify(body)).toBe(true);
      expect(accepts(schema, { ...body, spaceId: "space-9" }), JSON.stringify(body)).toBe(false);
    }
  });

  it("trim a group's name and refuse an empty or overlong one", () => {
    expect(createSpaceRequestSchema.parse({ name: "  Family  " })).toEqual({ name: "Family" });
    expect(accepts(createSpaceRequestSchema, { name: "   " })).toBe(false);
    expect(accepts(createSpaceRequestSchema, {})).toBe(false);
    expect(accepts(createSpaceRequestSchema, { name: "x".repeat(81) })).toBe(false);
    expect(spacePatchSchema.parse({ name: " Team " })).toEqual({ name: "Team" });
    expect(accepts(spacePatchSchema, { name: "" })).toBe(false);
  });

  it("add a member by address, as a member or an owner", () => {
    expect(addMemberRequestSchema.parse({ email: " lin@example.com " })).toEqual({ email: "lin@example.com" });
    expect(accepts(addMemberRequestSchema, { email: "lin@example.com", role: "owner", canAddApps: true })).toBe(true);
    expect(accepts(addMemberRequestSchema, { email: "lin@example.com", role: "admin" })).toBe(false);
    expect(accepts(addMemberRequestSchema, { email: "" })).toBe(false);
    expect(accepts(addMemberRequestSchema, { role: "member" })).toBe(false);
    expect(accepts(addMemberResponseSchema, { outcome: "invited" })).toBe(true);
    expect(accepts(addMemberResponseSchema, { outcome: "ignored" })).toBe(false);
  });

  it("take back an invitation by address", () => {
    expect(withdrawInvitationRequestSchema.parse({ email: " kim@example.com " })).toEqual({ email: "kim@example.com" });
    expect(accepts(withdrawInvitationRequestSchema, { email: "" })).toBe(false);
    expect(accepts(withdrawInvitationRequestSchema, {})).toBe(false);
  });

  it("change a member's role and right to add apps, each on its own", () => {
    expect(accepts(memberPatchSchema, { role: "owner" })).toBe(true);
    expect(accepts(memberPatchSchema, { canAddApps: false })).toBe(true);
    expect(accepts(memberPatchSchema, { role: "guest" })).toBe(false);
    expect(accepts(memberPatchSchema, { canAddApps: 1 })).toBe(false);
  });

  it("offer none, view and edit for the other members when an app is added or moved", () => {
    for (const memberAccess of ["none", "view", "edit"]) {
      expect(accepts(addAppRequestSchema, { memberAccess })).toBe(true);
      expect(accepts(moveAppRequestSchema, { toSpaceId: "space-2", memberAccess })).toBe(true);
    }
    // Left out is allowed: the server then gives the other members nothing.
    expect(addAppRequestSchema.parse({})).toEqual({});
    expect(accepts(addAppRequestSchema, { memberAccess: "owner" })).toBe(false);
    expect(accepts(moveAppRequestSchema, { memberAccess: "view" })).toBe(false);
    expect(accepts(moveAppRequestSchema, { toSpaceId: "" })).toBe(false);
  });

  it("set and clear access exceptions by user", () => {
    expect(
      appAccessRequestSchema.parse({ members: { "user-2": "edit", "user-3": "none", "user-4": null } }),
    ).toEqual({ members: { "user-2": "edit", "user-3": "none", "user-4": null } });
    expect(accepts(appAccessRequestSchema, { members: { "user-2": "owner" } })).toBe(false);
    expect(accepts(appAccessRequestSchema, { memberAccess: null })).toBe(false);
  });

  it("need the typed confirmation to delete an app's data", () => {
    expect(accepts(deleteAppDataRequestSchema, {})).toBe(false);
    expect(accepts(deleteAppDataRequestSchema, { confirm: true })).toBe(false);
  });

  it("switch and pin with booleans only", () => {
    expect(accepts(appPrefsPatchSchema, { enabled: false, pinned: true })).toBe(true);
    expect(accepts(appPrefsPatchSchema, { enabled: 0 })).toBe(false);
  });

  it("carry settings as text, numbers, switches and lists of text", () => {
    const values = { title: "Sample", limit: 5, hideDone: false, aisles: ["Fruit", "Dairy"] };
    expect(appSettingsSchema.parse({ space: values, user: {} })).toEqual({ space: values, user: {} });
    expect(accepts(appSettingsSchema, { space: values })).toBe(false);
    expect(accepts(appSettingsPatchSchema, { space: { aisles: [] } })).toBe(true);
    expect(accepts(appSettingsPatchSchema, { user: { filter: null } })).toBe(false);
    expect(accepts(appSettingsPatchSchema, { user: { filter: { nested: true } } })).toBe(false);
    expect(accepts(appSettingsPatchSchema, { user: { filter: [1, 2] } })).toBe(false);
  });

  it("carry any JSON to and from an app's routes, or nothing", () => {
    expect(appCallRequestSchema.parse({})).toEqual({});
    expect(appCallResponseSchema.parse({})).toEqual({});
    const rows = [{ id: "row-1", name: "Sample item", done: false, tags: ["a"], note: null }];
    expect(appCallResponseSchema.parse({ output: rows })).toEqual({ output: rows });
    expect(appCallRequestSchema.parse({ input: 3 })).toEqual({ input: 3 });
    expect(accepts(appCallRequestSchema, { input: new Date(0) })).toBe(false);
  });
});

describe("what the owners of a space see", () => {
  const view = {
    apps: [
      { id: "checklist", hasCode: true, removedAt: null, rowCount: 12, memberAccess: "view", members: { "user-2": "edit" } },
      { id: "retired", hasCode: false, removedAt: "2026-01-01T00:00:00.000Z", rowCount: 0, memberAccess: "none", members: {} },
    ],
    members: [
      { id: "user-1", name: "Sam Example", role: "owner", email: "sam@example.com", canAddApps: false },
      { id: "user-2", name: "Lin Example", role: "member", email: "lin@example.com", canAddApps: true },
    ],
    invitations: [{ email: "kim@example.com", role: "member", canAddApps: false }],
  };

  it("lists apps, members with their addresses, and people still to arrive", () => {
    expect(spaceAppsSchema.parse(view)).toEqual(view);
  });

  it("refuses a negative or fractional row count and an unknown level", () => {
    const withApp = (patch: object) => ({ ...view, apps: [{ ...view.apps[0], ...patch }] });
    expect(accepts(spaceAppsSchema, withApp({ rowCount: -1 }))).toBe(false);
    expect(accepts(spaceAppsSchema, withApp({ rowCount: 1.5 }))).toBe(false);
    expect(accepts(spaceAppsSchema, withApp({ memberAccess: "all" }))).toBe(false);
    expect(accepts(spaceAppsSchema, withApp({ members: { "user-2": null } }))).toBe(false);
  });
});

describe("a job's status", () => {
  const status = {
    lastStartedAt: "2026-03-01T13:05:00.000Z",
    lastSucceededAt: "2026-03-01T13:05:21.000Z",
    lastFailedAt: null,
    lastError: null,
    nextRunAt: "2026-03-01T14:05:00.000Z",
    state: "idle",
  };

  it("says when the runs started, went well and went wrong, why, when the next is, and where the job stands", () => {
    expect(jobStatusSchema.parse(status)).toEqual(status);
    const failed = { ...status, lastFailedAt: "2026-03-01T14:05:09.000Z", lastError: "The feed answered 500." };
    expect(jobStatusSchema.parse(failed)).toEqual(failed);
  });

  it("answers nulls for a job that has not run, and always when it runs next", () => {
    const fresh = { lastStartedAt: null, lastSucceededAt: null, lastFailedAt: null, lastError: null, nextRunAt: status.nextRunAt, state: "idle" };
    expect(accepts(jobStatusSchema, fresh)).toBe(true);
    expect(accepts(jobStatusSchema, { ...fresh, nextRunAt: null })).toBe(false);
    expect(accepts(jobStatusSchema, without(status, "lastError"))).toBe(false);
  });

  it("knows three states", () => {
    expect(JOB_STATES).toEqual(["idle", "requested", "running"]);
    for (const state of JOB_STATES) expect(accepts(jobStatusSchema, { ...status, state })).toBe(true);
    expect(accepts(jobStatusSchema, { ...status, state: "failed" })).toBe(false);
  });

  it("drops what it does not name, as every answer does, so that an older web app survives a newer server", () => {
    expect(jobStatusSchema.parse({ ...status, failures: 2 })).toEqual(status);
  });
});

describe("what a job's status means to the people who see the app", () => {
  const status = {
    lastStartedAt: null,
    lastSucceededAt: null,
    lastFailedAt: null,
    lastError: null,
    nextRunAt: "2026-03-01T13:05:00.000Z",
    state: "idle",
  } as const;
  const succeeded = "2026-03-01T13:05:21.000Z";
  const failed = "2026-03-01T14:05:09.000Z";

  it("is nothing before the first run", () => {
    expect(jobStateOf(status)).toEqual({ succeededAt: null, failedAt: null, running: false });
  });

  it("gives when the data is from, and a failure only when the last run to end went wrong", () => {
    expect(jobStateOf({ ...status, lastSucceededAt: succeeded })).toEqual({ succeededAt: succeeded, failedAt: null, running: false });
    // Failed after the run that went well: the data is still from then.
    expect(jobStateOf({ ...status, lastSucceededAt: succeeded, lastFailedAt: failed, lastError: "The feed answered 500." })).toEqual({
      succeededAt: succeeded,
      failedAt: failed,
      running: false,
    });
    // A run went well after the one that failed: that failure is over.
    expect(jobStateOf({ ...status, lastSucceededAt: failed, lastFailedAt: succeeded })).toEqual({
      succeededAt: failed,
      failedAt: null,
      running: false,
    });
    // Failed before any run went well.
    expect(jobStateOf({ ...status, lastFailedAt: failed })).toEqual({ succeededAt: null, failedAt: failed, running: false });
  });

  it("is running while a run holds the job and while one asked for has not started", () => {
    expect(jobStateOf({ ...status, state: "running" }).running).toBe(true);
    expect(jobStateOf({ ...status, state: "requested" }).running).toBe(true);
    expect(jobStateOf({ ...status, state: "idle" }).running).toBe(false);
  });
});
