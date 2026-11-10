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
      { id: expect.any(String), kind: "personal", name: "", role: "owner" },
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
    expect(spaces).toEqual([{ id: expect.any(String), kind: "personal", name: "", role: "owner" }]);
    expect(spaces[0]!.id).not.toBe(listSpacesForUser(db, owner.id)[0]!.id);

    // Still a member once the invitation is gone.
    expect(resolveMember(db, { email: "lin@example.com", ownerEmail: OWNER_EMAIL })).toEqual(lin);
  });
});
