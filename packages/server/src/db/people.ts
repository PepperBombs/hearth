/**
 * Users, spaces, membership and invitations: the tables that say who a
 * request is from and which spaces they may see. Data rows added by later
 * steps are scoped to one of these spaces.
 */
import type { Locale, PreferencesPatch, Space, SpaceMember, Theme, User } from "@hearth/shared";
import { normaliseEmail } from "../email";
import type { Db } from "./database";
import { newId } from "./ids";

type UserRow = { id: string; email: string; name: string; locale: Locale; theme: Theme };

const USER_COLUMNS = "id, email, name, locale, theme";

/** For writes: an address that cannot be stored is a mistake in the caller. */
function acceptedEmail(email: string): string {
  const normalised = normaliseEmail(email);
  if (!normalised) throw new Error("This is not an email address Hearth accepts.");
  return normalised;
}

export function findUserByEmail(db: Db, email: string): User | null {
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(normalised) as
    | UserRow
    | undefined;
  return row ?? null;
}

export function findUserById(db: Db, id: string): User | null {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as
    | UserRow
    | undefined;
  return row ?? null;
}

/** Creates a user together with their personal space, which they own. */
export function createUserWithPersonalSpace(
  db: Db,
  input: { email: string; locale: Locale },
): User {
  const email = acceptedEmail(input.email);
  const user: User = {
    id: newId(),
    email,
    name: email.split("@")[0] || email,
    locale: input.locale,
    theme: "system",
  };
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO users (id, email, name, locale, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(user.id, user.email, user.name, user.locale, user.theme, now);
    const spaceId = newId();
    // A personal space has no name of its own: the interface shows a translated label.
    db.prepare(
      "INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, 'personal', '', ?, ?)",
    ).run(spaceId, user.id, now);
    db.prepare(
      "INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    ).run(spaceId, user.id, now);
  })();
  return user;
}

/**
 * The spaces a person belongs to, personal space first, then groups from
 * oldest to newest, each with everyone in it in the order they joined.
 */
export function listSpacesForUser(db: Db, userId: string): Space[] {
  const spaces = db
    .prepare(
      `SELECT s.id, s.kind, s.name, m.role, m.can_add_apps AS canAddApps
         FROM space_members m
         JOIN spaces s ON s.id = m.space_id
        WHERE m.user_id = ?
        ORDER BY CASE s.kind WHEN 'personal' THEN 0 ELSE 1 END, s.created_at, s.id`,
    )
    .all(userId) as (Pick<Space, "id" | "kind" | "name" | "role"> & { canAddApps: 0 | 1 })[];

  // Only the members of spaces this person is in: the join starts from their own memberships.
  const members = db
    .prepare(
      `SELECT m.space_id AS spaceId, u.id, u.name, m.role
         FROM space_members mine
         JOIN space_members m ON m.space_id = mine.space_id
         JOIN users u ON u.id = m.user_id
        WHERE mine.user_id = ?
        ORDER BY m.created_at, u.id`,
    )
    .all(userId) as (SpaceMember & { spaceId: string })[];

  return spaces.map((space) => ({
    id: space.id,
    kind: space.kind,
    name: space.name,
    role: space.role,
    // Owners may always add apps; for a member it is the owners' choice.
    canAddApps: space.role === "owner" || space.canAddApps === 1,
    members: members
      .filter((member) => member.spaceId === space.id)
      .map(({ id, name, role }) => ({ id, name, role })),
  }));
}

/** Changes the given preferences and returns the user as they now are. */
export function updatePreferences(db: Db, userId: string, patch: PreferencesPatch): User | null {
  db.prepare(
    `UPDATE users
        SET name = coalesce(@name, name),
            locale = coalesce(@locale, locale),
            theme = coalesce(@theme, theme)
      WHERE id = @id`,
  ).run({
    id: userId,
    name: patch.name ?? null,
    locale: patch.locale ?? null,
    theme: patch.theme ?? null,
  });
  return findUserById(db, userId);
}

/** Allows a person in. They become a user the first time they arrive. Safe to repeat. */
export function addInvitation(db: Db, input: { email: string; invitedBy: string }): void {
  db.prepare(
    "INSERT INTO invitations (email, invited_by, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING",
  ).run(acceptedEmail(input.email), input.invitedBy, new Date().toISOString());
}

export function hasInvitation(db: Db, email: string): boolean {
  const normalised = normaliseEmail(email);
  if (!normalised) return false;
  return db.prepare("SELECT 1 FROM invitations WHERE email = ?").get(normalised) !== undefined;
}

export function deleteInvitation(db: Db, email: string): void {
  const normalised = normaliseEmail(email);
  if (normalised) db.prepare("DELETE FROM invitations WHERE email = ?").run(normalised);
}
