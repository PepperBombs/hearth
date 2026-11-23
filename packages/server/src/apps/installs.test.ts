/**
 * Who may use which app where (docs/mini-app-contract.md, section A6,
 * "Access"), asked of the functions directly. The routes are tested in
 * routes.test.ts.
 *
 * An app made in Hearth lives in one space. Where a test needs one app's ID
 * in two spaces, to hold VISIBLE to each space's own rows, it puts the
 * second install in directly (`install`), as the tables allow it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { madeAppsRegistry } from "../made/apps";
import { listAppsForUser, resolveInstall } from "./installs";
import type { Registry } from "./registry";
import { family, grant, install, JOURNAL, makeApp, setPrefs, unreadable } from "./test-world";

/** A server that holds no app at all. */
const noApps: Registry = { get: () => undefined, has: () => false };

const CHECKLIST = "m-checklist0";
const OTHER = "m-checklist1";
const JOURNAL_APP = "m-journal000";

let world: ReturnType<typeof family>;
let registry: Registry;
beforeEach(() => {
  world = family();
  registry = madeAppsRegistry(world.db);
});

describe("resolveInstall", () => {
  it("gives the owner of a personal space edit", () => {
    makeApp(world.db, world.samsSpace, CHECKLIST, world.sam.id);
    expect(resolveInstall(world.db, registry, world.sam.id, world.samsSpace, CHECKLIST)).toBe("edit");
  });

  it("is null for someone who is not in the space", () => {
    makeApp(world.db, world.samsSpace, CHECKLIST, world.sam.id, { memberAccess: "edit" });
    makeApp(world.db, world.family, OTHER, world.sam.id, { memberAccess: "edit" });
    expect(resolveInstall(world.db, registry, world.lin.id, world.samsSpace, CHECKLIST)).toBeNull();
    expect(resolveInstall(world.db, registry, world.noa.id, world.family, OTHER)).toBeNull();
  });

  it("is null for an app the space does not have, and for a space that does not exist", () => {
    makeApp(world.db, world.samsSpace, CHECKLIST, world.sam.id);
    makeApp(world.db, world.family, OTHER, world.sam.id);
    expect(resolveInstall(world.db, registry, world.sam.id, world.samsSpace, OTHER)).toBeNull();
    expect(resolveInstall(world.db, registry, world.sam.id, world.samsSpace, JOURNAL_APP)).toBeNull();
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, CHECKLIST)).toBeNull();
    expect(resolveInstall(world.db, registry, world.sam.id, "nowhere", CHECKLIST)).toBeNull();
    expect(resolveInstall(world.db, registry, "nobody", world.samsSpace, CHECKLIST)).toBeNull();
  });

  it("is null for a removed app, also for an owner", () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, {
      memberAccess: "edit",
      removedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, CHECKLIST)).toBeNull();
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, CHECKLIST)).toBeNull();
  });

  it("is null for an app the server holds no app for, also for an owner", () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "edit" });
    expect(resolveInstall(world.db, noApps, world.sam.id, world.family, CHECKLIST)).toBeNull();
    expect(resolveInstall(world.db, noApps, world.lin.id, world.family, CHECKLIST)).toBeNull();
    // The same rows with the app there.
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, CHECKLIST)).toBe("edit");
    // An install a release before the built-in apps left, which did not move: no app has its ID.
    install(world.db, world.family, "grocery", world.sam.id, { memberAccess: "edit" });
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, "grocery")).toBeNull();
  });

  it.each([
    ["none", null],
    ["view", "view"],
    ["edit", "edit"],
  ] as const)("gives a member what the app gives every member: %s -> %s", (memberAccess, expected) => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess });
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, CHECKLIST)).toBe(expected);
    // An owner has edit whatever members get.
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, CHECKLIST)).toBe("edit");
  });

  it.each([
    ["none", "edit", "edit"],
    ["none", "view", "view"],
    ["edit", "view", "view"],
    ["edit", "none", null],
    ["view", "none", null],
  ] as const)(
    "lets an exception for one member win: everyone %s, this member %s -> %s",
    (memberAccess, level, expected) => {
      makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess });
      grant(world.db, world.family, CHECKLIST, world.lin.id, level, world.sam.id);
      expect(resolveInstall(world.db, registry, world.lin.id, world.family, CHECKLIST)).toBe(expected);
      // The exception is Lin's alone.
      expect(resolveInstall(world.db, registry, world.kim.id, world.family, CHECKLIST)).toBe(
        memberAccess === "none" ? null : memberAccess,
      );
    },
  );

  it("gives every owner of a group edit, whatever an exception says", () => {
    world.db.prepare("UPDATE space_members SET role = 'owner' WHERE space_id = ? AND user_id = ?").run(
      world.family,
      world.lin.id,
    );
    makeApp(world.db, world.family, CHECKLIST, world.sam.id);
    grant(world.db, world.family, CHECKLIST, world.lin.id, "none", world.sam.id);
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, CHECKLIST)).toBe("edit");
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, CHECKLIST)).toBe("edit");
  });

  it("keeps an exception to the space it was made in", () => {
    // A second group with the same people and the same app.
    world.db
      .prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('club', 'group', 'Club', ?, ?)")
      .run(world.sam.id, "2026-01-08T00:00:00.000Z");
    const join = world.db.prepare(
      "INSERT INTO space_members (space_id, user_id, role, created_at) VALUES ('club', ?, ?, ?)",
    );
    join.run(world.sam.id, "owner", "2026-01-08T00:00:00.000Z");
    join.run(world.lin.id, "member", "2026-01-09T00:00:00.000Z");
    makeApp(world.db, world.family, CHECKLIST, world.sam.id);
    install(world.db, "club", CHECKLIST, world.sam.id);
    grant(world.db, world.family, CHECKLIST, world.lin.id, "edit", world.sam.id);

    expect(resolveInstall(world.db, registry, world.lin.id, world.family, CHECKLIST)).toBe("edit");
    expect(resolveInstall(world.db, registry, world.lin.id, "club", CHECKLIST)).toBeNull();
    expect(listAppsForUser(world.db, registry, world.lin.id).map((app) => app.spaceId)).toEqual([world.family]);
  });

  it("answers for the space asked about and no other", () => {
    // Lin has the app in her own space; that says nothing about the family's.
    makeApp(world.db, world.linsSpace, CHECKLIST, world.lin.id);
    install(world.db, world.family, CHECKLIST, world.sam.id);
    expect(resolveInstall(world.db, registry, world.lin.id, world.linsSpace, CHECKLIST)).toBe("edit");
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, CHECKLIST)).toBeNull();
  });
});

describe("listAppsForUser", () => {
  it("lists nothing when nothing was added", () => {
    expect(listAppsForUser(world.db, registry, world.sam.id)).toEqual([]);
  });

  it("describes an app from its manifest, as an app made in Hearth, its settings included", () => {
    makeApp(world.db, world.samsSpace, JOURNAL_APP, world.sam.id, { manifest: JOURNAL });
    makeApp(world.db, world.samsSpace, CHECKLIST, world.sam.id, { createdAt: "2026-01-02T00:00:00.000Z" });
    expect(listAppsForUser(world.db, registry, world.sam.id)).toEqual([
      {
        id: JOURNAL_APP,
        spaceId: world.samsSpace,
        name: { en: "Journal", zh: "日记" },
        description: { en: "One entry a day.", zh: "每天一篇。" },
        icon: "notebook-text",
        color: "purple",
        widgetSize: "wide",
        access: "edit",
        enabled: true,
        pinned: false,
        hasPage: true,
        made: true,
        version: 1,
      },
      {
        id: CHECKLIST,
        spaceId: world.samsSpace,
        name: { en: "Checklist", zh: "清单" },
        description: { en: "A list of things to do, ticked off as you go.", zh: "一份待办清单，完成一项勾选一项。" },
        icon: "list-checks",
        color: "teal",
        widgetSize: "tall",
        access: "edit",
        enabled: true,
        pinned: false,
        hasPage: true,
        made: true,
        version: 1,
        settings: {
          sections: {
            type: "list",
            scope: "space",
            default: [],
            maxItems: 20,
            maxLength: 40,
            label: { en: "Sections", zh: "分组" },
            help: { en: "Items are grouped in this order.", zh: "事项按此顺序分组。" },
          },
          hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的事项" } },
        },
      },
    ]);
  });

  it("lists exactly the apps resolveInstall lets the person use, with the same access", () => {
    makeApp(world.db, world.samsSpace, "m-samslist00", world.sam.id);
    makeApp(world.db, world.linsSpace, "m-linslist00", world.lin.id);
    makeApp(world.db, world.linsSpace, "m-linsdiary0", world.lin.id, { manifest: JOURNAL, removedAt: "2026-03-01T00:00:00.000Z" });
    install(world.db, world.kimsSpace, "gone", world.kim.id);
    makeApp(world.db, world.family, "m-ourlist000", world.sam.id, { memberAccess: "view" });
    makeApp(world.db, world.family, "m-ourdiary00", world.sam.id, { manifest: JOURNAL });
    grant(world.db, world.family, "m-ourlist000", world.kim.id, "none", world.sam.id);
    grant(world.db, world.family, "m-ourdiary00", world.kim.id, "edit", world.sam.id);

    const spaces = [world.samsSpace, world.linsSpace, world.kimsSpace, world.family];
    const apps = ["m-samslist00", "m-linslist00", "m-linsdiary0", "gone", "m-ourlist000", "m-ourdiary00"];
    for (const person of [world.sam, world.lin, world.kim, world.noa]) {
      const expected = spaces.flatMap((spaceId) =>
        apps.flatMap((appId) => {
          const access = resolveInstall(world.db, registry, person.id, spaceId, appId);
          return access ? [`${spaceId}/${appId}: ${access}`] : [];
        }),
      );
      const listed = listAppsForUser(world.db, registry, person.id).map(
        (app) => `${app.spaceId}/${app.id}: ${app.access}`,
      );
      expect(listed.sort()).toEqual(expected.sort());
    }

    // And those are the right ones.
    const seenBy = (userId: string) =>
      listAppsForUser(world.db, registry, userId).map((app) => [app.spaceId, app.id, app.access]);
    // Within a space, apps added at the same moment come by their IDs.
    expect(seenBy(world.sam.id)).toEqual([
      [world.samsSpace, "m-samslist00", "edit"],
      [world.family, "m-ourdiary00", "edit"],
      [world.family, "m-ourlist000", "edit"],
    ]);
    expect(seenBy(world.lin.id)).toEqual([
      [world.linsSpace, "m-linslist00", "edit"],
      [world.family, "m-ourlist000", "view"],
    ]);
    expect(seenBy(world.kim.id)).toEqual([[world.family, "m-ourdiary00", "edit"]]);
    expect(seenBy(world.noa.id)).toEqual([]);
  });

  it("puts the personal space first and keeps the order apps were added in", () => {
    makeApp(world.db, world.family, "m-ourdiary00", world.sam.id, { manifest: JOURNAL, createdAt: "2026-01-05T00:00:00.000Z" });
    makeApp(world.db, world.family, "m-ourlist000", world.sam.id, { createdAt: "2026-01-06T00:00:00.000Z" });
    makeApp(world.db, world.samsSpace, "m-samslist00", world.sam.id, { createdAt: "2026-01-07T00:00:00.000Z" });
    expect(listAppsForUser(world.db, registry, world.sam.id).map((app) => [app.spaceId, app.id])).toEqual([
      [world.samsSpace, "m-samslist00"],
      [world.family, "m-ourdiary00"],
      [world.family, "m-ourlist000"],
    ]);
  });

  it("keeps an app the person switched off, and shows their own switch and pin only", () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "edit" });
    setPrefs(world.db, world.family, CHECKLIST, world.lin.id, { enabled: false, pinned: true });
    const of = (userId: string) => {
      const [app] = listAppsForUser(world.db, registry, userId);
      return { enabled: app?.enabled, pinned: app?.pinned };
    };
    expect(of(world.lin.id)).toEqual({ enabled: false, pinned: true });
    expect(of(world.sam.id)).toEqual({ enabled: true, pinned: false });
    expect(of(world.kim.id)).toEqual({ enabled: true, pinned: false });
  });

  it("keeps a switch and a pin to the space they were set in", () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "edit" });
    install(world.db, world.linsSpace, CHECKLIST, world.lin.id);
    setPrefs(world.db, world.family, CHECKLIST, world.lin.id, { enabled: false, pinned: true });
    expect(
      listAppsForUser(world.db, registry, world.lin.id).map((app) => [app.spaceId, app.enabled, app.pinned]),
    ).toEqual([
      [world.linsSpace, true, false],
      [world.family, false, true],
    ]);
  });

  it("leaves out an app whose manifest this release cannot read, and lists it again once it can", () => {
    makeApp(world.db, world.family, CHECKLIST, world.sam.id, { memberAccess: "edit" });
    const putBack = unreadable(world.db, CHECKLIST);
    expect(registry.has(CHECKLIST)).toBe(false);
    expect(listAppsForUser(world.db, registry, world.lin.id)).toEqual([]);
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, CHECKLIST)).toBeNull();
    putBack();
    expect(listAppsForUser(world.db, registry, world.lin.id).map((app) => [app.id, app.access])).toEqual([[CHECKLIST, "edit"]]);
  });
});
