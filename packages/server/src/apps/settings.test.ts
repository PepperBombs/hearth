/**
 * An app's settings in one space (docs/mini-app-contract.md, sections A2, A6
 * and A8, and the owner's decision 5), through the two routes
 * `GET` and `PATCH /api/spaces/:spaceId/apps/:appId/settings`, which the
 * settings dialog and an app's page (`hearth.settings()`) both use. A later
 * release of an app is a later version of it (`changeMadeApp`), and going
 * back is `restoreMadeVersion`.
 */
import { apiErrorSchema, appSettingsSchema, type ApiErrorCode, type AppSettings } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { changeMadeApp, madeAppsRegistry, restoreMadeVersion } from "../made/apps";
import { madeManifestSchema, type MadeManifest } from "../made/manifest";
import { as, testApp } from "../testing";
import { family, grant, install, KIM, LIN, makeApp, NOA, NOW, SAM, unreadable } from "./test-world";

const BASE = "http://hearth.example.com";
const PLANNER = "m-planner000";
const PLAIN = "m-plain00000";
const CHECKLIST = "m-checklist0";

let world: ReturnType<typeof family>;
let app: ReturnType<typeof testApp>["app"];
let errors: unknown[];

/* -------------------------------------------------------------------------
 * A sample app with one setting of every type, some shared by the space and
 * some each person's own.
 * ---------------------------------------------------------------------- */
const plannerManifest: MadeManifest = madeManifestSchema.parse({
  name: { en: "Planner", zh: "计划" },
  description: { en: "Plans the week's meals.", zh: "安排一周的饭菜。" },
  icon: "utensils",
  color: "amber",
  collections: { meals: { fields: { name: { type: "text", required: true } } } },
  settings: {
    title: { type: "text", scope: "space", default: "This week", maxLength: 20, label: { en: "Title", zh: "标题" } },
    servings: {
      type: "number",
      scope: "space",
      default: 4,
      min: 1,
      max: 12,
      step: 1,
      label: { en: "Servings", zh: "份数" },
    },
    courses: {
      type: "list",
      scope: "space",
      default: ["Main"],
      maxItems: 3,
      maxLength: 10,
      label: { en: "Courses", zh: "菜式" },
    },
    firstDay: {
      type: "select",
      scope: "space",
      default: "monday",
      label: { en: "Week starts on", zh: "一周始于" },
      options: {
        monday: { en: "Monday", zh: "周一" },
        saturday: { en: "Saturday", zh: "周六" },
        sunday: { en: "Sunday", zh: "周日" },
      },
    },
    compact: { type: "switch", scope: "user", default: false, label: { en: "Compact", zh: "紧凑" } },
    diets: {
      type: "multi-select",
      scope: "user",
      default: [],
      label: { en: "Diets", zh: "饮食" },
      options: {
        vegan: { en: "Vegan", zh: "纯素" },
        halal: { en: "Halal", zh: "清真" },
        kosher: { en: "Kosher", zh: "洁食" },
      },
    },
    nickname: { type: "text", scope: "user", default: "", label: { en: "Nickname", zh: "昵称" } },
  },
});

/** An app that declares no settings at all. */
const plainManifest: MadeManifest = madeManifestSchema.parse({
  name: { en: "Plain", zh: "朴素" },
  description: { en: "Has no settings.", zh: "没有设置。" },
  icon: "box",
  color: "blue",
  size: "small",
  collections: { notes: { fields: { text: { type: "text" } } } },
});

const DEFAULTS: AppSettings = {
  space: { title: "This week", servings: 4, courses: ["Main"], firstDay: "monday" },
  user: { compact: false, diets: [], nickname: "" },
};

/**
 * The planner as a later version of it declares its settings, made by Sam,
 * as a change in the chat would make it. Returns what takes the app back to
 * the version before, as an undo does.
 */
function release(change: (settings: Record<string, unknown>) => void): () => void {
  const settings: Record<string, unknown> = structuredClone(plannerManifest.settings ?? {});
  change(settings);
  const registry = madeAppsRegistry(world.db);
  const request = { userId: world.sam.id, spaceId: world.family, appId: PLANNER, by: "person" as const };
  const { previous } = changeMadeApp(world.db, registry, { ...request, manifest: { ...plannerManifest, settings }, note: "A later version" });
  return () => {
    restoreMadeVersion(world.db, registry, { ...request, version: previous });
  };
}

beforeEach(() => {
  world = family();
  ({ app, errors } = testApp({ db: world.db }));
  // The family's planner, which members may view; Sam owns the family.
  makeApp(world.db, world.family, PLANNER, world.sam.id, { manifest: plannerManifest, memberAccess: "view" });
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

const read = (who: string | null, spaceId: string, appId = PLANNER) =>
  call(who, "GET", `/api/spaces/${spaceId}/apps/${appId}/settings`);
const save = (who: string | null, spaceId: string, patch: unknown, appId = PLANNER) =>
  call(who, "PATCH", `/api/spaces/${spaceId}/apps/${appId}/settings`, patch);

/** The answer of a settings route that worked. Strict, so that nothing but the two groups may be in it. */
async function settingsIn(response: Response): Promise<AppSettings> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return appSettingsSchema.strict().parse(await response.json());
}

const settingsOf = async (who: string, spaceId: string, appId = PLANNER) => settingsIn(await read(who, spaceId, appId));

async function expectError(response: Response, status: number, code: ApiErrorCode): Promise<string> {
  expect(response.status).toBe(status);
  const { error } = apiErrorSchema.parse(await response.json());
  expect(error.code).toBe(code);
  return error.message;
}

type Stored = {
  space_id: string;
  app_id: string;
  user_id: string | null;
  data: string;
  created_by: string;
  updated_by: string;
  updated_at: string;
};

/** Every stored settings object, as the database has it. */
const stored = () =>
  world.db.prepare("SELECT * FROM app_settings ORDER BY space_id, app_id, user_id").all() as Stored[];

/** What is stored for one app in one space: the space's values under "space", each person's under their ID. */
function storedFor(spaceId: string, appId = PLANNER): Record<string, unknown> {
  return Object.fromEntries(
    stored()
      .filter((row) => row.space_id === spaceId && row.app_id === appId)
      .map((row) => [row.user_id ?? "space", JSON.parse(row.data) as unknown]),
  );
}

/** Puts a settings object straight into the database, as an earlier version of the app might have left it. */
function leave(spaceId: string, userId: string | null, data: unknown, appId = PLANNER): void {
  world.db
    .prepare(
      `INSERT INTO app_settings (space_id, app_id, user_id, data, created_by, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(spaceId, appId, userId, JSON.stringify(data), world.sam.id, world.sam.id, NOW);
}

describe("reading an app's settings", () => {
  it("fills in every default while nothing is saved, and stores nothing", async () => {
    expect(await settingsOf(SAM, world.family)).toEqual(DEFAULTS);
    expect(stored()).toEqual([]);
  });

  it("puts each setting under its scope and nowhere else", async () => {
    const settings = await settingsOf(SAM, world.family);
    expect(Object.keys(settings.space).sort()).toEqual(["courses", "firstDay", "servings", "title"]);
    expect(Object.keys(settings.user).sort()).toEqual(["compact", "diets", "nickname"]);
  });

  it("answers with two empty groups for an app that has no settings", async () => {
    makeApp(world.db, world.samsSpace, PLAIN, world.sam.id, { manifest: plainManifest });
    expect(await settingsOf(SAM, world.samsSpace, PLAIN)).toEqual({ space: {}, user: {} });
  });

  it("is open to someone who may only view the app", async () => {
    expect(await settingsOf(LIN, world.family)).toEqual(DEFAULTS);
  });

});

describe("saving a setting the space shares", () => {
  it("answers with every setting as it is now", async () => {
    const answer = await settingsIn(await save(SAM, world.family, { space: { title: "Next week" } }));
    expect(answer).toEqual({ space: { ...DEFAULTS.space, title: "Next week" }, user: DEFAULTS.user });
  });

  it("changes it for everyone in the space", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Next week", servings: 6 } }));
    for (const who of [SAM, LIN, KIM]) {
      expect((await settingsOf(who, world.family)).space, who).toEqual({ ...DEFAULTS.space, title: "Next week", servings: 6 });
    }
  });

  it("stores one object for the space, holding only what was saved", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Next week" } }));
    expect(storedFor(world.family)).toEqual({ space: { title: "Next week" } });
    const [row] = stored();
    expect(row).toMatchObject({ space_id: world.family, app_id: PLANNER, user_id: null, created_by: world.sam.id });
  });

  it("changes only the settings that are named", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Next week", servings: 6 } }));
    const answer = await settingsIn(await save(SAM, world.family, { space: { servings: 2 } }));
    expect(answer.space).toEqual({ ...DEFAULTS.space, title: "Next week", servings: 2 });
    expect(storedFor(world.family)).toEqual({ space: { title: "Next week", servings: 2 } });
    expect(stored()).toHaveLength(1);
  });

  it("takes a value of every type, and replaces a list as a whole", async () => {
    const space = { title: "", servings: 12, courses: ["Soup", "Main", "Sweet"], firstDay: "sunday" };
    expect((await settingsIn(await save(SAM, world.family, { space }))).space).toEqual(space);
    const shorter = await settingsIn(await save(SAM, world.family, { space: { courses: [] } }));
    expect(shorter.space).toEqual({ ...space, courses: [] });
  });

  it("keeps a value that equals the default, so that a later default does not change it", async () => {
    await settingsIn(await save(SAM, world.family, { space: { servings: 4 } }));
    expect(storedFor(world.family)).toEqual({ space: { servings: 4 } });
    release((settings) => {
      (settings.servings as { default: number }).default = 2;
      (settings.title as { default: string }).default = "Meals";
    });
    const settings = await settingsOf(SAM, world.family);
    expect(settings.space.servings).toBe(4);
    // What nobody saved follows the manifest.
    expect(settings.space.title).toBe("Meals");
  });

  it("records who saved first, who saved last and when", async () => {
    grant(world.db, world.family, PLANNER, world.lin.id, "edit", world.sam.id);
    await settingsIn(await save(SAM, world.family, { space: { title: "Sam's" } }));
    const first = stored()[0];
    expect(first).toMatchObject({ created_by: world.sam.id, updated_by: world.sam.id });

    const before = Date.now();
    await settingsIn(await save(LIN, world.family, { space: { title: "Lin's" } }));
    const [row] = stored();
    expect(row).toMatchObject({ created_by: world.sam.id, updated_by: world.lin.id });
    expect(Date.parse(row?.updated_at ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(row?.updated_at ?? "")).toBeLessThanOrEqual(Date.now());
  });

  it("is allowed to a member with edit access, not only to owners", async () => {
    grant(world.db, world.family, PLANNER, world.kim.id, "edit", world.sam.id);
    const answer = await settingsIn(await save(KIM, world.family, { space: { firstDay: "saturday" } }));
    expect(answer.space.firstDay).toBe("saturday");
    expect((await settingsOf(SAM, world.family)).space.firstDay).toBe("saturday");
  });

  it("is refused to someone who may only view, and changes nothing", async () => {
    const message = await expectError(await save(LIN, world.family, { space: { title: "Lin's" } }), 403, "forbidden");
    expect(message).toContain("edit access");
    expect(stored()).toEqual([]);
    expect((await settingsOf(SAM, world.family)).space.title).toBe("This week");
  });

  it("is refused as a whole: a viewer's own setting in the same request is not saved either", async () => {
    await expectError(await save(LIN, world.family, { space: { title: "Lin's" }, user: { compact: true } }), 403, "forbidden");
    expect(stored()).toEqual([]);
    expect((await settingsOf(LIN, world.family)).user.compact).toBe(false);
  });

  it("tells a viewer nothing about what a shared setting would accept", async () => {
    for (const space of [{ title: 7 }, { nothing: true }, { servings: 1.5 }, { compact: true }]) {
      await expectError(await save(LIN, world.family, { space }), 403, "forbidden");
    }
    expect(stored()).toEqual([]);
  });
});

describe("saving a person's own setting", () => {
  it("is theirs alone: nobody else's value changes", async () => {
    const answer = await settingsIn(await save(SAM, world.family, { user: { compact: true, diets: ["halal", "vegan"] } }));
    expect(answer).toEqual({ space: DEFAULTS.space, user: { compact: true, diets: ["halal", "vegan"], nickname: "" } });
    expect((await settingsOf(LIN, world.family)).user).toEqual(DEFAULTS.user);
    expect((await settingsOf(KIM, world.family)).user).toEqual(DEFAULTS.user);
  });

  it("is allowed with view access", async () => {
    const answer = await settingsIn(await save(LIN, world.family, { user: { compact: true, nickname: "Lin" } }));
    expect(answer.user).toEqual({ compact: true, diets: [], nickname: "Lin" });
    expect((await settingsOf(LIN, world.family)).user).toEqual({ compact: true, diets: [], nickname: "Lin" });
    expect((await settingsOf(SAM, world.family)).user).toEqual(DEFAULTS.user);
  });

  it("stores one object for each person, apart from the space's", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Ours" }, user: { nickname: "Sam" } }));
    await settingsIn(await save(LIN, world.family, { user: { nickname: "Lin" } }));
    await settingsIn(await save(LIN, world.family, { user: { compact: true } }));
    expect(storedFor(world.family)).toEqual({
      space: { title: "Ours" },
      [world.sam.id]: { nickname: "Sam" },
      [world.lin.id]: { nickname: "Lin", compact: true },
    });
    expect(stored()).toHaveLength(3);
    const lins = stored().find((row) => row.user_id === world.lin.id);
    expect(lins).toMatchObject({ created_by: world.lin.id, updated_by: world.lin.id });
  });

  it("holds for one space: the same person has other values for the same app elsewhere", async () => {
    // The planner's ID in Sam's own space too, as the tables allow.
    install(world.db, world.samsSpace, PLANNER, world.sam.id);
    await settingsIn(await save(SAM, world.family, { space: { title: "Family" }, user: { nickname: "Dad" } }));
    expect(await settingsOf(SAM, world.samsSpace)).toEqual(DEFAULTS);

    await settingsIn(await save(SAM, world.samsSpace, { space: { title: "Mine" }, user: { nickname: "Sam" } }));
    expect(await settingsOf(SAM, world.family)).toEqual({
      space: { ...DEFAULTS.space, title: "Family" },
      user: { ...DEFAULTS.user, nickname: "Dad" },
    });
    expect(await settingsOf(SAM, world.samsSpace)).toEqual({
      space: { ...DEFAULTS.space, title: "Mine" },
      user: { ...DEFAULTS.user, nickname: "Sam" },
    });
  });

  it("holds for one app: a setting of the same name in another app is another setting", async () => {
    // The checklist has a `hideDone` of each person's own and a shared `sections`.
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "view" });
    await settingsIn(await save(SAM, world.family, { space: { sections: ["Home"] }, user: { hideDone: true } }, CHECKLIST));
    expect(await settingsOf(SAM, world.family)).toEqual(DEFAULTS);
    expect(await settingsOf(SAM, world.family, CHECKLIST)).toEqual({ space: { sections: ["Home"] }, user: { hideDone: true } });
    expect(await settingsOf(LIN, world.family, CHECKLIST)).toEqual({ space: { sections: ["Home"] }, user: { hideDone: false } });
    // And the planner does not take the checklist's names.
    await expectError(await save(SAM, world.family, { user: { hideDone: true } }), 400, "invalid_request");
  });
});

describe("a request that names nothing to save", () => {
  it("answers with the settings and stores nothing, also for a viewer", async () => {
    for (const patch of [{}, { space: {} }, { user: {} }, { space: {}, user: {} }]) {
      expect(await settingsIn(await save(LIN, world.family, patch)), JSON.stringify(patch)).toEqual(DEFAULTS);
    }
    expect(stored()).toEqual([]);
  });
});

describe("a request that does not fit the app's manifest", () => {
  const refused: [why: string, patch: unknown, names: string][] = [
    ["a name the app does not declare", { space: { colour: "red" } }, "space.colour"],
    ["a name every object has", { space: { toString: "x" } }, "space.toString"],
    ["a name every object has", { user: { constructor: "x" } }, "user.constructor"],
    ["a person's own setting sent as the space's", { space: { compact: true } }, "space.compact"],
    ["the space's setting sent as a person's own", { user: { title: "Mine" } }, "user.title"],
    ["a number for a text", { space: { title: 7 } }, "space.title"],
    ["a text that is too long", { space: { title: "x".repeat(21) } }, "space.title"],
    ["a text for a number", { space: { servings: "6" } }, "space.servings"],
    ["a number below min", { space: { servings: 0 } }, "space.servings"],
    ["a number above max", { space: { servings: 13 } }, "space.servings"],
    ["a number between steps", { space: { servings: 2.5 } }, "space.servings"],
    ["a text for a switch", { user: { compact: "yes" } }, "user.compact"],
    ["a select value that is not an option", { space: { firstDay: "friday" } }, "space.firstDay"],
    ["a list for a select", { space: { firstDay: ["monday"] } }, "space.firstDay"],
    ["a multi-select key that is not an option", { user: { diets: ["vegan", "paleo"] } }, "user.diets.1"],
    ["a multi-select key given twice", { user: { diets: ["vegan", "vegan"] } }, "user.diets.1"],
    ["a text for a multi-select", { user: { diets: "vegan" } }, "user.diets"],
    ["a list with too many items", { space: { courses: ["One", "Two", "Three", "Four"] } }, "space.courses"],
    ["a list item that is too long", { space: { courses: ["Main", "x".repeat(11)] } }, "space.courses.1"],
    ["a text for a list", { space: { courses: "Main" } }, "space.courses"],
  ];

  it.each(refused)("refuses %s", async (_why, patch, names) => {
    const message = await expectError(await save(SAM, world.family, patch), 400, "invalid_request");
    expect(message.startsWith(`${names}: `), message).toBe(true);
    expect(stored()).toEqual([]);
    expect(await settingsOf(SAM, world.family)).toEqual(DEFAULTS);
  });

  it("refuses what no setting can hold, and a body of another shape", async () => {
    const bodies: unknown[] = [
      { space: { title: null } },
      { space: { title: { text: "x" } } },
      { space: { courses: ["Main", 2] } },
      { space: "title" },
      { user: [] },
      { everyone: { title: "x" } },
      { space: {}, title: "x" },
      [],
      "not json",
    ];
    for (const body of bodies) {
      await expectError(await save(SAM, world.family, body), 400, "invalid_request");
    }
    expect(stored()).toEqual([]);
  });

  it("saves nothing of a request in which one value is wrong", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Before" }, user: { nickname: "Sam" } }));
    const before = stored();
    await expectError(
      await save(SAM, world.family, { space: { title: "After", servings: 6 }, user: { nickname: "Sammy", diets: ["paleo"] } }),
      400,
      "invalid_request",
    );
    await expectError(
      await save(SAM, world.family, { space: { title: "After", servings: 99 }, user: { nickname: "Sammy" } }),
      400,
      "invalid_request",
    );
    expect(stored()).toEqual(before);
  });

  it("refuses every name for an app without settings", async () => {
    makeApp(world.db, world.samsSpace, PLAIN, world.sam.id, { manifest: plainManifest });
    await expectError(await save(SAM, world.samsSpace, { space: { title: "x" } }, PLAIN), 400, "invalid_request");
    await expectError(await save(SAM, world.samsSpace, { user: { title: "x" } }, PLAIN), 400, "invalid_request");
    expect(await settingsIn(await save(SAM, world.samsSpace, {}, PLAIN))).toEqual({ space: {}, user: {} });
    expect(stored()).toEqual([]);
  });

  it("is not logged: it is the request's fault, not the server's", async () => {
    await expectError(await save(SAM, world.family, { space: { servings: 99 } }), 400, "invalid_request");
    await expectError(await save(LIN, world.family, { space: { servings: 6 } }), 403, "forbidden");
    expect(errors).toEqual([]);
  });
});

describe("an app that is not there for the person", () => {
  const patch = { user: { compact: true } };

  /** Reading and saving both answer 404, with the same words as any unknown address, and nothing is stored. */
  async function expectNothingThere(who: string, spaceId: string, appId = PLANNER) {
    const messages = [
      await expectError(await read(who, spaceId, appId), 404, "not_found"),
      await expectError(await save(who, spaceId, patch, appId), 404, "not_found"),
      await expectError(await save(who, spaceId, { space: { title: "x" } }, appId), 404, "not_found"),
    ];
    const unknown = await expectError(await call(who, "GET", "/api/nothing/here"), 404, "not_found");
    expect(new Set([...messages, unknown]).size).toBe(1);
    expect(stored()).toEqual([]);
  }

  it("answers 404 to someone who is not in the space", async () => {
    await expectNothingThere(NOA, world.family);
    await expectNothingThere(LIN, world.samsSpace);
  });

  it("answers 404 to a member the app is hidden from", async () => {
    grant(world.db, world.family, PLANNER, world.lin.id, "none", world.sam.id);
    await expectNothingThere(LIN, world.family);
    // Kim still follows what every member gets.
    expect(await settingsOf(KIM, world.family)).toEqual(DEFAULTS);
  });

  it("answers 404 for an app the space does not have, or that does not exist", async () => {
    makeApp(world.db, world.samsSpace, PLAIN, world.sam.id, { manifest: plainManifest });
    await expectNothingThere(SAM, world.samsSpace);
    await expectNothingThere(SAM, world.family, PLAIN);
    await expectNothingThere(SAM, world.family, "m-journal000");
    await expectNothingThere(SAM, world.family, "no-such-app");
    await expectNothingThere(SAM, "no-such-space");
  });

  it("answers 404 for an app that was removed from the space, to its owner too", async () => {
    world.db.prepare("UPDATE space_apps SET removed_at = ? WHERE app_id = ?").run(NOW, PLANNER);
    await expectNothingThere(SAM, world.family);
  });

  it("answers 404 for an app the server no longer holds", async () => {
    unreadable(world.db, PLANNER);
    await expectNothingThere(SAM, world.family);
    // Nor for an install a release before the built-in apps left, which could not move.
    install(world.db, world.family, "grocery", world.sam.id, { memberAccess: "edit" });
    await expectNothingThere(SAM, world.family, "grocery");
  });

  it("answers 401 to a request with no sign-in", async () => {
    await expectError(await read(null, world.family), 401, "unauthenticated");
    await expectError(await save(null, world.family, patch), 401, "unauthenticated");
    expect(stored()).toEqual([]);
  });

  it("answers 404 to other methods on the address", async () => {
    for (const method of ["PUT", "POST", "DELETE"]) {
      await expectError(await call(SAM, method, `/api/spaces/${world.family}/apps/${PLANNER}/settings`, {}), 404, "not_found");
    }
  });
});

describe("what was saved, read against the manifest as it is today", () => {
  it("drops values under names the manifest does not declare", async () => {
    leave(world.family, null, { title: "Kept", theme: "dark", toString: "x" });
    leave(world.family, world.sam.id, { nickname: "Sam", fontSize: 12 });
    expect(await settingsOf(SAM, world.family)).toEqual({
      space: { ...DEFAULTS.space, title: "Kept" },
      user: { ...DEFAULTS.user, nickname: "Sam" },
    });
  });

  it("drops a setting that a later version no longer has, and finds it again when it returns", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Ours", servings: 6 } }));
    const back = release((settings) => {
      delete settings.servings;
    });
    const answer = await settingsOf(SAM, world.family);
    expect(answer.space).toEqual({ title: "Ours", courses: ["Main"], firstDay: "monday" });
    await expectError(await save(SAM, world.family, { space: { servings: 8 } }), 400, "invalid_request");

    // Saving something else under the later version leaves the value where it is...
    await settingsIn(await save(SAM, world.family, { space: { title: "Still ours" } }));
    expect(storedFor(world.family)).toEqual({ space: { title: "Still ours", servings: 6 } });
    // ...so the version before it, put back, still has it.
    back();
    expect((await settingsOf(SAM, world.family)).space).toEqual({ ...DEFAULTS.space, title: "Still ours", servings: 6 });
  });

  it("does not read a value saved under the other scope", async () => {
    leave(world.family, null, { title: "Ours", compact: true, nickname: "Everyone" });
    leave(world.family, world.sam.id, { title: "Mine", servings: 9 });
    expect(await settingsOf(SAM, world.family)).toEqual({ space: { ...DEFAULTS.space, title: "Ours" }, user: DEFAULTS.user });
  });

  it("reads a value that no longer fits its setting as the default", async () => {
    leave(world.family, null, {
      title: "x".repeat(21),
      servings: 40,
      courses: ["One", "Two", "Three", "Four"],
      firstDay: "friday",
    });
    leave(world.family, world.sam.id, { compact: "yes", nickname: 7, diets: "vegan" });
    expect(await settingsOf(SAM, world.family)).toEqual(DEFAULTS);
    expect(errors).toEqual([]);
  });

  it("judges each value by itself: one that does not fit does not take the others with it", async () => {
    leave(world.family, null, { title: "Ours", servings: 2.5, firstDay: "sunday", courses: null });
    expect((await settingsOf(SAM, world.family)).space).toEqual({
      title: "Ours",
      servings: 4,
      courses: ["Main"],
      firstDay: "sunday",
    });
  });

  it("falls back to the default when the option someone chose is gone", async () => {
    await settingsIn(await save(SAM, world.family, { space: { firstDay: "saturday" } }));
    const back = release((settings) => {
      delete (settings.firstDay as { options: Record<string, unknown> }).options.saturday;
    });
    expect((await settingsOf(SAM, world.family)).space.firstDay).toBe("monday");
    expect((await settingsOf(LIN, world.family)).space.firstDay).toBe("monday");
    // The stored choice is as it was, and counts again once the option is back.
    expect(storedFor(world.family)).toEqual({ space: { firstDay: "saturday" } });
    back();
    expect((await settingsOf(SAM, world.family)).space.firstDay).toBe("saturday");
  });

  it("keeps what is left of a multi-select when one of its options is gone", async () => {
    await settingsIn(await save(SAM, world.family, { user: { diets: ["kosher", "halal", "vegan"] } }));
    const back = release((settings) => {
      delete (settings.diets as { options: Record<string, unknown> }).options.halal;
    });
    expect((await settingsOf(SAM, world.family)).user.diets).toEqual(["kosher", "vegan"]);
    // The stored choice is as it was, for the day the option returns.
    expect(storedFor(world.family)).toEqual({ [world.sam.id]: { diets: ["kosher", "halal", "vegan"] } });
    back();
    expect((await settingsOf(SAM, world.family)).user.diets).toEqual(["kosher", "halal", "vegan"]);
  });

  it("takes anything that is not an object of values for nothing saved, and saves over it", async () => {
    leave(world.family, null, ["title", "Ours"]);
    leave(world.family, world.sam.id, "compact");
    leave(world.family, world.lin.id, null);
    expect(await settingsOf(SAM, world.family)).toEqual(DEFAULTS);
    expect(await settingsOf(LIN, world.family)).toEqual(DEFAULTS);

    await settingsIn(await save(SAM, world.family, { space: { title: "Ours" }, user: { compact: true } }));
    expect(storedFor(world.family)).toEqual({
      space: { title: "Ours" },
      [world.sam.id]: { compact: true },
      [world.lin.id]: null,
    });
    expect(stored()).toHaveLength(3);
  });
});

describe("settings and the life of an app in a space", () => {
  const add = (who: string, spaceId: string, body: unknown = {}) =>
    call(who, "PUT", `/api/spaces/${spaceId}/apps/${PLANNER}`, body);
  const remove = (who: string, spaceId: string) => call(who, "DELETE", `/api/spaces/${spaceId}/apps/${PLANNER}`);

  it("come back with the app when it was removed and is added again", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Ours" }, user: { nickname: "Sam" } }));
    await settingsIn(await save(LIN, world.family, { user: { nickname: "Lin" } }));
    expect((await remove(SAM, world.family)).status).toBe(204);
    await expectError(await read(SAM, world.family), 404, "not_found");

    expect((await add(SAM, world.family, { memberAccess: "view" })).status).toBe(204);
    expect(await settingsOf(SAM, world.family)).toEqual({
      space: { ...DEFAULTS.space, title: "Ours" },
      user: { ...DEFAULTS.user, nickname: "Sam" },
    });
    expect((await settingsOf(LIN, world.family)).user.nickname).toBe("Lin");
  });

  it("are gone for good once the app's data is deleted, with the app itself", async () => {
    await settingsIn(await save(SAM, world.family, { space: { title: "Ours" }, user: { nickname: "Sam" } }));
    await settingsIn(await save(LIN, world.family, { user: { nickname: "Lin" } }));
    expect((await remove(SAM, world.family)).status).toBe(204);
    const gone = await call(SAM, "DELETE", `/api/spaces/${world.family}/apps/${PLANNER}/data`, { confirm: PLANNER });
    expect(gone.status).toBe(204);
    expect(stored()).toEqual([]);
    await expectError(await add(SAM, world.family, { memberAccess: "view" }), 404, "not_found");

    // An app made there again, even under the same ID, finds nothing of before.
    makeApp(world.db, world.family, PLANNER, world.sam.id, { manifest: plannerManifest, memberAccess: "view" });
    expect(await settingsOf(SAM, world.family)).toEqual(DEFAULTS);
    expect(await settingsOf(LIN, world.family)).toEqual(DEFAULTS);
  });

  it("of a person go with the person when they leave the space; the space's stay", async () => {
    grant(world.db, world.family, PLANNER, world.lin.id, "edit", world.sam.id);
    await settingsIn(await save(LIN, world.family, { space: { title: "Lin's title" }, user: { nickname: "Lin" } }));
    world.db.prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?").run(world.family, world.lin.id);
    expect(storedFor(world.family)).toEqual({ space: { title: "Lin's title" } });
    expect((await settingsOf(SAM, world.family)).space.title).toBe("Lin's title");
  });
});
