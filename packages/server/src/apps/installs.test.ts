/**
 * Who may use which app where (docs/mini-app-contract.md, section A6,
 * "Access"), asked of the functions directly. The routes are tested in
 * routes.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { listAppsForUser, resolveInstall } from "./installs";
import { createRegistry } from "./registry";
import { APPS, family, grant, install, setPrefs } from "./test-world";

const registry = createRegistry(APPS);
const noApps = createRegistry([]);

let world: ReturnType<typeof family>;
beforeEach(() => {
  world = family();
});

describe("resolveInstall", () => {
  it("gives the owner of a personal space edit", () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    expect(resolveInstall(world.db, registry, world.sam.id, world.samsSpace, "checklist")).toBe("edit");
  });

  it("is null for someone who is not in the space", () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id, { memberAccess: "edit" });
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    expect(resolveInstall(world.db, registry, world.lin.id, world.samsSpace, "checklist")).toBeNull();
    expect(resolveInstall(world.db, registry, world.noa.id, world.family, "checklist")).toBeNull();
  });

  it("is null for an app the space does not have, and for a space that does not exist", () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    expect(resolveInstall(world.db, registry, world.sam.id, world.samsSpace, "journal")).toBeNull();
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, "checklist")).toBeNull();
    expect(resolveInstall(world.db, registry, world.sam.id, "nowhere", "checklist")).toBeNull();
    expect(resolveInstall(world.db, registry, "nobody", world.samsSpace, "checklist")).toBeNull();
  });

  it("is null for a removed app, also for an owner", () => {
    install(world.db, world.family, "checklist", world.sam.id, {
      memberAccess: "edit",
      removedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, "checklist")).toBeNull();
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, "checklist")).toBeNull();
  });

  it("is null for an app the server holds no code for, also for an owner", () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    expect(resolveInstall(world.db, noApps, world.sam.id, world.family, "checklist")).toBeNull();
    expect(resolveInstall(world.db, noApps, world.lin.id, world.family, "checklist")).toBeNull();
    // The same rows with the code back.
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, "checklist")).toBe("edit");
  });

  it.each([
    ["none", null],
    ["view", "view"],
    ["edit", "edit"],
  ] as const)("gives a member what the app gives every member: %s -> %s", (memberAccess, expected) => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess });
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, "checklist")).toBe(expected);
    // An owner has edit whatever members get.
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, "checklist")).toBe("edit");
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
      install(world.db, world.family, "checklist", world.sam.id, { memberAccess });
      grant(world.db, world.family, "checklist", world.lin.id, level, world.sam.id);
      expect(resolveInstall(world.db, registry, world.lin.id, world.family, "checklist")).toBe(expected);
      // The exception is Lin's alone.
      expect(resolveInstall(world.db, registry, world.kim.id, world.family, "checklist")).toBe(
        memberAccess === "none" ? null : memberAccess,
      );
    },
  );

  it("gives every owner of a group edit, whatever an exception says", () => {
    world.db.prepare("UPDATE space_members SET role = 'owner' WHERE space_id = ? AND user_id = ?").run(
      world.family,
      world.lin.id,
    );
    install(world.db, world.family, "checklist", world.sam.id);
    grant(world.db, world.family, "checklist", world.lin.id, "none", world.sam.id);
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, "checklist")).toBe("edit");
    expect(resolveInstall(world.db, registry, world.sam.id, world.family, "checklist")).toBe("edit");
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
    install(world.db, world.family, "checklist", world.sam.id);
    install(world.db, "club", "checklist", world.sam.id);
    grant(world.db, world.family, "checklist", world.lin.id, "edit", world.sam.id);

    expect(resolveInstall(world.db, registry, world.lin.id, world.family, "checklist")).toBe("edit");
    expect(resolveInstall(world.db, registry, world.lin.id, "club", "checklist")).toBeNull();
    expect(listAppsForUser(world.db, registry, world.lin.id).map((app) => app.spaceId)).toEqual([world.family]);
  });

  it("answers for the space asked about and no other", () => {
    // Lin has the app in her own space; that says nothing about the family's.
    install(world.db, world.linsSpace, "checklist", world.lin.id);
    install(world.db, world.family, "checklist", world.sam.id);
    expect(resolveInstall(world.db, registry, world.lin.id, world.linsSpace, "checklist")).toBe("edit");
    expect(resolveInstall(world.db, registry, world.lin.id, world.family, "checklist")).toBeNull();
  });
});

describe("listAppsForUser", () => {
  it("lists nothing when nothing was added", () => {
    expect(listAppsForUser(world.db, registry, world.sam.id)).toEqual([]);
  });

  it("describes an app from its manifest", () => {
    install(world.db, world.samsSpace, "journal", world.sam.id);
    expect(listAppsForUser(world.db, registry, world.sam.id)).toEqual([
      {
        id: "journal",
        spaceId: world.samsSpace,
        name: { en: "Journal", zh: "日记" },
        description: { en: "One entry a day, for you alone.", zh: "每天一篇，只给自己看。" },
        icon: "notebook-text",
        color: "purple",
        widgetSize: "wide",
        access: "edit",
        enabled: true,
        pinned: false,
        hasPage: true,
      },
    ]);
  });

  it("lists exactly the apps resolveInstall lets the person use, with the same access", () => {
    install(world.db, world.samsSpace, "checklist", world.sam.id);
    install(world.db, world.linsSpace, "checklist", world.lin.id);
    install(world.db, world.linsSpace, "journal", world.lin.id, { removedAt: "2026-03-01T00:00:00.000Z" });
    install(world.db, world.kimsSpace, "gone", world.kim.id);
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
    install(world.db, world.family, "journal", world.sam.id);
    grant(world.db, world.family, "checklist", world.kim.id, "none", world.sam.id);
    grant(world.db, world.family, "journal", world.kim.id, "edit", world.sam.id);

    const spaces = [world.samsSpace, world.linsSpace, world.kimsSpace, world.family];
    for (const person of [world.sam, world.lin, world.kim, world.noa]) {
      const expected = spaces.flatMap((spaceId) =>
        ["checklist", "journal", "gone"].flatMap((appId) => {
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
    expect(seenBy(world.sam.id)).toEqual([
      [world.samsSpace, "checklist", "edit"],
      [world.family, "checklist", "edit"],
      [world.family, "journal", "edit"],
    ]);
    expect(seenBy(world.lin.id)).toEqual([
      [world.linsSpace, "checklist", "edit"],
      [world.family, "checklist", "view"],
    ]);
    expect(seenBy(world.kim.id)).toEqual([[world.family, "journal", "edit"]]);
    expect(seenBy(world.noa.id)).toEqual([]);
  });

  it("puts the personal space first and keeps the order apps were added in", () => {
    install(world.db, world.family, "journal", world.sam.id, { createdAt: "2026-01-05T00:00:00.000Z" });
    install(world.db, world.family, "checklist", world.sam.id, { createdAt: "2026-01-06T00:00:00.000Z" });
    install(world.db, world.samsSpace, "checklist", world.sam.id, { createdAt: "2026-01-07T00:00:00.000Z" });
    expect(listAppsForUser(world.db, registry, world.sam.id).map((app) => [app.spaceId, app.id])).toEqual([
      [world.samsSpace, "checklist"],
      [world.family, "journal"],
      [world.family, "checklist"],
    ]);
  });

  it("keeps an app the person switched off, and shows their own switch and pin only", () => {
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    setPrefs(world.db, world.family, "checklist", world.lin.id, { enabled: false, pinned: true });
    const of = (userId: string) => {
      const [app] = listAppsForUser(world.db, registry, userId);
      return { enabled: app?.enabled, pinned: app?.pinned };
    };
    expect(of(world.lin.id)).toEqual({ enabled: false, pinned: true });
    expect(of(world.sam.id)).toEqual({ enabled: true, pinned: false });
    expect(of(world.kim.id)).toEqual({ enabled: true, pinned: false });
  });

  it("keeps a switch and a pin to the space they were set in", () => {
    install(world.db, world.linsSpace, "checklist", world.lin.id);
    install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
    setPrefs(world.db, world.family, "checklist", world.lin.id, { enabled: false, pinned: true });
    expect(
      listAppsForUser(world.db, registry, world.lin.id).map((app) => [app.spaceId, app.enabled, app.pinned]),
    ).toEqual([
      [world.linsSpace, true, false],
      [world.family, false, true],
    ]);
  });
});
