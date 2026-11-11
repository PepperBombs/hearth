/**
 * A small world for tests of apps in spaces: four people, their personal
 * spaces and one group. Sample data only. Not part of the running server.
 */
import { defineApp } from "@hearth/sdk";
import type { Db } from "../db/database";
import { createUserWithPersonalSpace } from "../db/people";
import { FIXTURE_APPS, OWNER_EMAIL, testDatabase } from "../testing";
import type { BundledApp } from "./registry";

/** An app that may only be added to a personal space. */
export const journal = defineApp({
  id: "journal",
  name: { en: "Journal", zh: "日记" },
  description: { en: "One entry a day, for you alone.", zh: "每天一篇，只给自己看。" },
  icon: "notebook-text",
  color: "purple",
  spaces: ["personal"],
  widget: { size: "wide" },
});

/** The sample checklist, which has no page, and the journal, which has one. */
export const APPS: readonly BundledApp[] = [
  ...FIXTURE_APPS,
  { id: "journal", manifest: journal, hasPage: true },
];

export const NOW = "2026-01-01T00:00:00.000Z";

export const SAM = OWNER_EMAIL;
export const LIN = "lin@example.com";
export const KIM = "kim@example.com";
export const NOA = "noa@example.com";

/**
 * Sam owns the server and the group "family". Lin is a plain member of it,
 * Kim a member who may add apps. Noa is on the server but not in the family.
 */
export function family(db: Db = testDatabase()) {
  const sam = createUserWithPersonalSpace(db, { email: SAM, locale: "en" });
  const lin = createUserWithPersonalSpace(db, { email: LIN, locale: "zh" });
  const kim = createUserWithPersonalSpace(db, { email: KIM, locale: "en" });
  const noa = createUserWithPersonalSpace(db, { email: NOA, locale: "en" });
  const personal = (userId: string) =>
    (
      db
        .prepare("SELECT id FROM spaces WHERE created_by = ? AND kind = 'personal'")
        .get(userId) as { id: string }
    ).id;
  db.prepare(
    "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('family', 'group', 'Family', ?, ?)",
  ).run(sam.id, "2026-01-02T00:00:00.000Z");
  const join = db.prepare(
    "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES ('family', ?, ?, ?, ?)",
  );
  join.run(sam.id, "owner", 0, "2026-01-02T00:00:00.000Z");
  join.run(lin.id, "member", 0, "2026-01-03T00:00:00.000Z");
  join.run(kim.id, "member", 1, "2026-01-04T00:00:00.000Z");
  return {
    db,
    sam,
    lin,
    kim,
    noa,
    family: "family",
    samsSpace: personal(sam.id),
    linsSpace: personal(lin.id),
    kimsSpace: personal(kim.id),
  };
}

/** Puts an app in a space directly, as the add route would have. */
export function install(
  db: Db,
  spaceId: string,
  appId: string,
  createdBy: string,
  options: { memberAccess?: "none" | "view" | "edit"; removedAt?: string; createdAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO space_apps (space_id, app_id, member_access, created_by, created_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    spaceId,
    appId,
    options.memberAccess ?? "none",
    createdBy,
    options.createdAt ?? NOW,
    options.removedAt ?? null,
  );
}

/** An owner's exception for one member. */
export function grant(
  db: Db,
  spaceId: string,
  appId: string,
  userId: string,
  level: "none" | "view" | "edit",
  by: string,
): void {
  db.prepare(
    `INSERT INTO app_access (space_id, app_id, user_id, level, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(spaceId, appId, userId, level, by, NOW);
}

/** A person's own switch and pin for an app. */
export function setPrefs(
  db: Db,
  spaceId: string,
  appId: string,
  userId: string,
  prefs: { enabled: boolean; pinned: boolean },
): void {
  db.prepare(
    "INSERT INTO app_prefs (space_id, app_id, user_id, enabled, pinned) VALUES (?, ?, ?, ?, ?)",
  ).run(spaceId, appId, userId, prefs.enabled ? 1 : 0, prefs.pinned ? 1 : 0);
}

export function count(db: Db, table: string, spaceId: string, appId: string): number {
  return (
    db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id = ? AND app_id = ?`)
      .get(spaceId, appId) as { n: number }
  ).n;
}
