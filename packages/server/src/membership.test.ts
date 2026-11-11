import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db/database";
import { addInvitation, hasInvitation, listSpacesForUser } from "./db/people";
import { localeFromAcceptLanguage, resolveMember } from "./membership";
import { OWNER_EMAIL, testDatabase } from "./testing";

describe("localeFromAcceptLanguage", () => {
  it.each([
    ["zh-CN,zh;q=0.9,en;q=0.8", "zh"],
    ["zh", "zh"],
    ["zh-TW", "zh"],
    ["ZH-hans-CN", "zh"],
    ["fr-FR,zh;q=0.8,en;q=0.5", "zh"],
    ["en;q=0.5, zh;q=0.9", "zh"],
    ["en-US,en;q=0.9,zh-CN;q=0.8", "en"],
    ["en, zh", "en"],
    ["fr-FR,de;q=0.8", "en"],
    ["zh;q=0, en;q=0.1", "en"],
    ["*", "en"],
    ["", "en"],
    [";;,,q=", "en"],
  ] as const)("%s -> %s", (header, locale) => {
    expect(localeFromAcceptLanguage(header)).toBe(locale);
  });

  it("is English when the header is absent", () => {
    expect(localeFromAcceptLanguage(undefined)).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });
});

describe("resolveMember", () => {
  let db: Db;
  const count = (table: "users" | "spaces" | "space_members" | "invitations") =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    db = testDatabase();
  });

  it("creates the owner on first sight, with a personal space they own", () => {
    const user = resolveMember(db, {
      email: OWNER_EMAIL,
      ownerEmail: OWNER_EMAIL,
      acceptLanguage: "zh-CN,zh;q=0.9",
    });
    expect(user).toMatchObject({
      email: OWNER_EMAIL,
      name: "owner",
      locale: "zh",
      theme: "system",
    });
    expect(listSpacesForUser(db, user!.id)).toEqual([
      {
        id: expect.any(String),
        kind: "personal",
        name: "",
        role: "owner",
        canAddApps: true,
        members: [{ id: user!.id, name: "owner", role: "owner" }],
      },
    ]);
  });

  it("returns the same user afterwards and creates nothing more", () => {
    const first = resolveMember(db, { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL });
    const second = resolveMember(db, {
      email: "Owner@Example.com",
      ownerEmail: OWNER_EMAIL,
      acceptLanguage: "zh",
    });
    expect(second).toEqual(first);
    expect(second?.locale).toBe("en");
    expect([count("users"), count("spaces"), count("space_members")]).toEqual([1, 1, 1]);
  });

  it("turns a stranger away and stores nothing about them", () => {
    expect(resolveMember(db, { email: "stranger@example.com", ownerEmail: OWNER_EMAIL })).toBeNull();
    expect([count("users"), count("spaces")]).toEqual([0, 0]);
  });

  it("creates an invited person on first sight and uses the invitation up", () => {
    const owner = resolveMember(db, { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL })!;
    addInvitation(db, { email: "Lin@Example.com", invitedBy: owner.id });
    addInvitation(db, { email: "lin@example.com", invitedBy: owner.id });
    expect(count("invitations")).toBe(1);

    const lin = resolveMember(db, { email: "lin@example.com", ownerEmail: OWNER_EMAIL })!;
    expect(lin).toMatchObject({ email: "lin@example.com", name: "lin", locale: "en" });
    expect(lin.id).not.toBe(owner.id);
    expect(hasInvitation(db, "lin@example.com")).toBe(false);

    const spaces = listSpacesForUser(db, lin.id);
    expect(spaces).toEqual([
      {
        id: expect.any(String),
        kind: "personal",
        name: "",
        role: "owner",
        canAddApps: true,
        // Their own space holds them alone: the owner of the server is not in it.
        members: [{ id: lin.id, name: "lin", role: "owner" }],
      },
    ]);
    expect(spaces[0]!.id).not.toBe(listSpacesForUser(db, owner.id)[0]!.id);

    // Still a member once the invitation is gone.
    expect(resolveMember(db, { email: "lin@example.com", ownerEmail: OWNER_EMAIL })).toEqual(lin);
  });

  it("makes an invited person a member of the groups that invited them, as each invitation says", () => {
    const owner = resolveMember(db, { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL })!;
    const group = (id: string, name: string) => {
      db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)").run(
        id,
        name,
        owner.id,
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
        id,
        owner.id,
        "2026-01-01T00:00:00.000Z",
      );
    };
    group("family", "Family");
    group("team", "Team");
    const invite = db.prepare(
      `INSERT INTO space_invitations (space_id, email, role, can_add_apps, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-01-02T00:00:00.000Z')`,
    );
    invite.run("family", "lin@example.com", "member", 1, owner.id);
    invite.run("team", "lin@example.com", "owner", 0, owner.id);
    invite.run("team", "kim@example.com", "member", 0, owner.id);
    addInvitation(db, { email: "lin@example.com", invitedBy: owner.id });

    const lin = resolveMember(db, { email: "LIN@example.com", ownerEmail: OWNER_EMAIL })!;
    expect(listSpacesForUser(db, lin.id).map((space) => [space.kind, space.name, space.role, space.canAddApps])).toEqual([
      ["personal", "", "owner", true],
      ["group", "Family", "member", true],
      ["group", "Team", "owner", true],
    ]);
    // Lin's invitations are used up; Kim's is untouched.
    expect(db.prepare("SELECT email FROM space_invitations").all()).toEqual([{ email: "kim@example.com" }]);
    expect(hasInvitation(db, "lin@example.com")).toBe(false);
  });

  it("does not let a group's invitation alone in: the server's own invitation decides", () => {
    const owner = resolveMember(db, { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL })!;
    db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('family', 'group', 'Family', ?, ?)").run(
      owner.id,
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES ('family', ?, 'owner', ?)").run(
      owner.id,
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO space_invitations (space_id, email, invited_by, created_at)
       VALUES ('family', 'lin@example.com', ?, '2026-01-02T00:00:00.000Z')`,
    ).run(owner.id);
    expect(resolveMember(db, { email: "lin@example.com", ownerEmail: OWNER_EMAIL })).toBeNull();
    expect(count("users")).toBe(1);
  });

  it("treats the two ways of writing an accented letter as one person", () => {
    const composed = "jos\u00e9@example.com";
    const decomposed = "jose\u0301@example.com";
    const owner = resolveMember(db, { email: OWNER_EMAIL, ownerEmail: OWNER_EMAIL })!;
    addInvitation(db, { email: composed, invitedBy: owner.id });

    const first = resolveMember(db, { email: decomposed, ownerEmail: OWNER_EMAIL });
    expect(first).toMatchObject({ email: composed });
    expect(resolveMember(db, { email: composed, ownerEmail: OWNER_EMAIL })).toEqual(first);
    expect(count("users")).toBe(2);
  });

  it("does not take a look-alike of the owner's address for the owner", () => {
    const ownerEmail = "mike@example.com";
    // U+212A, the Kelvin sign, lower-cases to "k".
    const lookAlike = "mi\u212ae@example.com";
    expect(resolveMember(db, { email: lookAlike, ownerEmail })).toBeNull();
    expect(count("users")).toBe(0);

    const owner = resolveMember(db, { email: ownerEmail, ownerEmail })!;
    expect(resolveMember(db, { email: lookAlike, ownerEmail })).toBeNull();
    expect(() => addInvitation(db, { email: lookAlike, invitedBy: owner.id })).toThrow();
    expect(count("users")).toBe(1);
  });
});
