/**
 * Groups and the people in them: creating a group, renaming it, adding
 * people, changing their role and their right to add apps, removing them,
 * and the invitations of people who are not on the server yet
 * (docs/mini-app-contract.md, sections A6 and A8, and the owner's decisions
 * 3 and 4).
 *
 * - Only the owners of a group manage it. Anyone in it may leave it.
 * - A group keeps at least one owner. The database refuses to remove or
 *   demote the last one (the triggers on `space_members`), and that refusal
 *   is answered with 409 `conflict`.
 * - A personal space is for one person: nobody is added to it, its owner
 *   does not leave it, and it has no name to change.
 * - Who may create a group, and who may invite someone who is not on the
 *   server yet, is `groupRights` (./policy.ts); the route passes its answer in.
 *
 * Every function checks who is asking and makes its change in one immediate
 * transaction, and turns a request down by throwing a Refusal.
 */
import type {
  AddMemberRequest,
  MemberPatch,
  Space,
  SpaceInvitation,
  SpaceMemberDetail,
  SpaceRole,
} from "@hearth/shared";
import Database from "better-sqlite3";
import type { Db } from "../db/database";
import { newId } from "../db/ids";
import { addInvitation, deleteInvitation, findUserByEmail, listSpacesForUser, membershipOf } from "../db/people";
import { normaliseEmail } from "../email";
import { notFound, Refusal } from "../http/errors";
import type { GroupRights } from "./policy";

/** Who asks about which space. */
export type SpaceRequest = { userId: string; spaceId: string };

/**
 * Checks that the person asking owns the group: 404 when they are not in
 * the space (or it does not exist), 403 when they are a plain member, 409
 * when it is a personal space, which has no members to manage.
 */
function requireGroupOwner(db: Db, { userId, spaceId }: SpaceRequest, action: string): void {
  const member = membershipOf(db, userId, spaceId);
  if (!member) throw notFound();
  if (member.role !== "owner") throw new Refusal(403, "forbidden", `${action} is for the group's owners.`);
  if (member.kind === "personal") throw new Refusal(409, "conflict", "A personal space is for one person: it has no members and no name to change.");
}

/**
 * Makes a change to `space_members`. The database refuses one that would
 * leave a space without an owner; that is answered with 409 `conflict`.
 */
function keepingAnOwner(change: () => void): void {
  try {
    change();
  } catch (error) {
    if (error instanceof Database.SqliteError && error.code === "SQLITE_CONSTRAINT_TRIGGER") {
      throw new Refusal(409, "conflict", "A group must keep at least one owner. Make someone else an owner first.");
    }
    throw error;
  }
}

/**
 * Creates a group with the person asking as its one owner, and answers with
 * it as their session lists it.
 *
 * Throws a Refusal: 403 when this person may not create groups.
 */
export function createGroup(db: Db, rights: GroupRights, request: { userId: string; name: string }): Space {
  if (!rights.canCreateGroups) {
    throw new Refusal(403, "forbidden", "Creating groups is not open to everyone on this server.");
  }
  const spaceId = newId();
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)").run(
      spaceId,
      request.name,
      request.userId,
      now,
    );
    // The owner first: the database refuses a space whose first member is not one.
    db.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
      spaceId,
      request.userId,
      now,
    );
  }).immediate();
  const space = listSpacesForUser(db, request.userId).find((candidate) => candidate.id === spaceId);
  if (!space) throw new Error("A group disappeared while it was being created.");
  return space;
}

/**
 * Renames a group. Leaving the name out changes nothing.
 *
 * Throws a Refusal: 404 when the person is not in the space, 403 when they
 * do not own it, 409 for a personal space.
 */
export function renameGroup(db: Db, request: SpaceRequest & { name?: string }): void {
  db.transaction(() => {
    requireGroupOwner(db, request, "Renaming a group");
    if (request.name === undefined) return;
    db.prepare("UPDATE spaces SET name = ? WHERE id = ?").run(request.name, request.spaceId);
  }).immediate();
}

/**
 * Adds someone to a group by their email address. Someone already on the
 * server becomes a member at once ("added"). Anyone else is invited, if the
 * person asking may invite people: they are let onto the server, and become
 * a member with the role asked for when they first arrive ("invited").
 *
 * Throws a Refusal: 404, 403 and 409 as `requireGroupOwner`; 400 for an
 * address Hearth does not accept; 403 for an address that is not on the
 * server when the person asking may not invite people; 409 when the person
 * is already in the group, or already invited to it.
 */
export function addMember(
  db: Db,
  rights: GroupRights,
  request: SpaceRequest & AddMemberRequest,
): "added" | "invited" {
  const { userId, spaceId } = request;
  return db
    .transaction((): "added" | "invited" => {
      requireGroupOwner(db, request, "Adding people to a group");
      const email = normaliseEmail(request.email);
      if (!email) throw new Refusal(400, "invalid_request", "email: This is not an email address Hearth accepts.");
      const role: SpaceRole = request.role ?? "member";
      const canAddApps = request.canAddApps === true ? 1 : 0;
      const now = new Date().toISOString();

      const user = findUserByEmail(db, email);
      if (user) {
        if (membershipOf(db, user.id, spaceId)) {
          throw new Refusal(409, "conflict", "This person is already in the group.");
        }
        db.prepare(
          "INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(spaceId, user.id, role, canAddApps, now);
        return "added";
      }

      if (!rights.canInvitePeople) {
        throw new Refusal(
          403,
          "forbidden",
          "Nobody with this address is on this server yet, and inviting new people is not open to everyone here.",
        );
      }
      const invited = db.prepare("SELECT 1 FROM space_invitations WHERE space_id = ? AND email = ?").get(spaceId, email);
      if (invited) throw new Refusal(409, "conflict", "This address is already invited to the group.");
      // Lets them onto the server; the row below makes them a member when they arrive.
      addInvitation(db, { email, invitedBy: userId });
      db.prepare(
        `INSERT INTO space_invitations (space_id, email, role, can_add_apps, invited_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(spaceId, email, role, canAddApps, userId, now);
      return "invited";
    })
    .immediate();
}

/**
 * Changes a member's role, or whether they may add apps. What the patch
 * leaves out stays as it is. Exceptions made for them as a member stay too:
 * as an owner they can use every app, and the exceptions apply again if
 * they stop being one.
 *
 * Throws a Refusal: 404, 403 and 409 as `requireGroupOwner`; 404 when the
 * person to change is not in the group; 409 when it would leave the group
 * without an owner.
 */
export function changeMember(db: Db, request: SpaceRequest & { memberId: string; patch: MemberPatch }): void {
  const { spaceId, memberId, patch } = request;
  db.transaction(() => {
    requireGroupOwner(db, request, "Changing what a member may do");
    if (!membershipOf(db, memberId, spaceId)) throw notFound();
    if (patch.role === undefined && patch.canAddApps === undefined) return;
    const flag = patch.canAddApps === undefined ? null : patch.canAddApps ? 1 : 0;
    keepingAnOwner(() =>
      db
        .prepare(
          `UPDATE space_members
              SET role = coalesce(@role, role), can_add_apps = coalesce(@canAddApps, can_add_apps)
            WHERE space_id = @spaceId AND user_id = @memberId`,
        )
        .run({ spaceId, memberId, role: patch.role ?? null, canAddApps: flag }),
    );
  }).immediate();
}

/**
 * Takes someone out of a group: an owner removing a member, or anyone
 * leaving. Their exceptions, switches, pins and own settings in the group's
 * apps go with them (the database cascades); the rows they wrote stay,
 * since they belong to the group.
 *
 * Throws a Refusal: 404 when the person asking is not in the space, or the
 * person to remove is not; 403 when a plain member removes someone else;
 * 409 for a personal space, and when it would leave the group without an
 * owner.
 */
export function removeMember(db: Db, request: SpaceRequest & { memberId: string }): void {
  const { userId, spaceId, memberId } = request;
  db.transaction(() => {
    const caller = membershipOf(db, userId, spaceId);
    if (!caller) throw notFound();
    const leaving = memberId === userId;
    if (!leaving && caller.role !== "owner") {
      throw new Refusal(403, "forbidden", "Removing someone from a group is for the group's owners.");
    }
    if (caller.kind === "personal") {
      throw new Refusal(409, "conflict", "A personal space is for one person: nobody joins or leaves it.");
    }
    if (!leaving && !membershipOf(db, memberId, spaceId)) throw notFound();
    keepingAnOwner(() =>
      db.prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?").run(spaceId, memberId),
    );
  }).immediate();
}

/**
 * Takes back the invitation of someone who has not arrived yet. When it was
 * their last invitation to a group, they are no longer let onto the server
 * either: inviting them to a group is what let them in.
 *
 * Throws a Refusal: 404, 403 and 409 as `requireGroupOwner`; 404 when the
 * group has no invitation for this address.
 */
export function withdrawInvitation(db: Db, request: SpaceRequest & { email: string }): void {
  const { spaceId } = request;
  db.transaction(() => {
    requireGroupOwner(db, request, "Taking back an invitation");
    const email = normaliseEmail(request.email);
    if (!email) throw notFound();
    const removed = db.prepare("DELETE FROM space_invitations WHERE space_id = ? AND email = ?").run(spaceId, email);
    if (removed.changes === 0) throw notFound();
    const elsewhere = db.prepare("SELECT 1 FROM space_invitations WHERE email = ?").get(email);
    if (!elsewhere) deleteInvitation(db, email);
  }).immediate();
}

/**
 * Everyone in a space as its owners see them, in the order they joined: with
 * their email address and whether they may add apps, which the session does
 * not tell other members. The caller has checked that the person asking
 * owns the space.
 */
export function listMemberDetails(db: Db, spaceId: string): SpaceMemberDetail[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.can_add_apps AS canAddApps
         FROM space_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.space_id = ?
        ORDER BY m.created_at, u.id`,
    )
    .all(spaceId) as (Omit<SpaceMemberDetail, "canAddApps"> & { canAddApps: 0 | 1 })[];
  return rows.map((row) => ({ ...row, canAddApps: row.canAddApps === 1 }));
}

/** The people invited to a space who have not arrived yet, oldest invitation first. The caller has checked who asks. */
export function listInvitations(db: Db, spaceId: string): SpaceInvitation[] {
  const rows = db
    .prepare(
      `SELECT email, role, can_add_apps AS canAddApps
         FROM space_invitations
        WHERE space_id = ?
        ORDER BY created_at, email`,
    )
    .all(spaceId) as (Omit<SpaceInvitation, "canAddApps"> & { canAddApps: 0 | 1 })[];
  return rows.map((row) => ({ ...row, canAddApps: row.canAddApps === 1 }));
}
