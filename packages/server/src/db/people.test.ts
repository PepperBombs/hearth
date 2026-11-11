import { beforeEach, describe, expect, it } from "vitest";
import { spaceSchema } from "@hearth/shared";
import { testDatabase } from "../testing";
import type { Db } from "./database";
import { createUserWithPersonalSpace, listSpacesForUser, updatePreferences } from "./people";

describe("listSpacesForUser", () => {
  let db: Db;
  let sam: string;
  let lin: string;
  let kim: string;

  /** No route creates groups yet, so the rows are written here as that route will write them. */
  function group(id: string, name: string, createdAt: string, members: [string, string, number?][]) {
    db.prepare(
      "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)",
    ).run(id, name, members[0]![0], createdAt);
    members.forEach(([userId, role, canAddApps = 0], index) => {
      db.prepare(
        "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, userId, role, canAddApps, `${createdAt.slice(0, 10)}T00:00:0${index}.000Z`);
    });
  }

  beforeEach(() => {
    db = testDatabase();
    sam = createUserWithPersonalSpace(db, { email: "sam@example.com", locale: "en" }).id;
    lin = createUserWithPersonalSpace(db, { email: "lin@example.com", locale: "zh" }).id;
    kim = createUserWithPersonalSpace(db, { email: "kim@example.com", locale: "en" }).id;
    updatePreferences(db, sam, { name: "Sam Example" });
    updatePreferences(db, lin, { name: "Lin Example" });
    updatePreferences(db, kim, { name: "Kim Example" });
  });

  it("lists the personal space first, then groups from oldest to newest", () => {
    group("team", "Team", "2026-03-01T00:00:00.000Z", [[sam, "owner"]]);
    group("family", "Family", "2026-02-01T00:00:00.000Z", [[sam, "owner"]]);
    expect(listSpacesForUser(db, sam).map((space) => [space.kind, space.name])).toEqual([
      ["personal", ""],
      ["group", "Family"],
      ["group", "Team"],
    ]);
  });

  it("gives each space its members in the order they joined, with their roles", () => {
    group("family", "Family", "2026-02-01T00:00:00.000Z", [
      [sam, "owner"],
      [lin, "member"],
      [kim, "owner"],
    ]);
    const family = listSpacesForUser(db, lin).find((space) => space.id === "family");
    expect(family).toEqual({
      id: "family",
      kind: "group",
      name: "Family",
      role: "member",
      canAddApps: false,
      members: [
        { id: sam, name: "Sam Example", role: "owner" },
        { id: lin, name: "Lin Example", role: "member" },
        { id: kim, name: "Kim Example", role: "owner" },
      ],
    });
    // Nothing but what the contract names: a member's email address stays out.
    spaceSchema.extend({ members: spaceSchema.shape.members.element.strict().array() }).strict().parse(family);
  });

  it("says who may add apps: every owner, and the members an owner allowed", () => {
    group("family", "Family", "2026-02-01T00:00:00.000Z", [
      [sam, "owner"],
      [lin, "member", 1],
      [kim, "member"],
    ]);
    const canAddApps = (userId: string) =>
      listSpacesForUser(db, userId).map((space) => [space.kind, space.canAddApps]);
    expect(canAddApps(sam)).toEqual([["personal", true], ["group", true]]);
    expect(canAddApps(lin)).toEqual([["personal", true], ["group", true]]);
    expect(canAddApps(kim)).toEqual([["personal", true], ["group", false]]);
  });

  it("shows nothing of a space the person is not in", () => {
    group("family", "Family", "2026-02-01T00:00:00.000Z", [
      [sam, "owner"],
      [lin, "member"],
    ]);
    const spaces = listSpacesForUser(db, kim);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      kind: "personal",
      members: [{ id: kim, name: "Kim Example", role: "owner" }],
    });
    expect(JSON.stringify(spaces)).not.toContain("Family");
    expect(JSON.stringify(spaces)).not.toContain("Sam Example");
  });
});
