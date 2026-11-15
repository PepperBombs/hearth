/**
 * What an assistant may do in a space: the owners' switch
 * (docs/mini-app-contract.md, section F, "The switches").
 *
 * The level is a column of `spaces`; whether one app is left out is a
 * column of `space_apps`, set through the access route (installs.ts). What
 * an assistant may then do with an app for one person is worked out in
 * `VISIBLE` (installs.ts) alone.
 */
import type { MemberAccess } from "@hearth/shared";
import type { Db } from "../db/database";
import { membershipOf } from "../db/people";
import { notFound, Refusal } from "../http/errors";

export type AssistantLevelRequest = { userId: string; spaceId: string; level: MemberAccess };

/**
 * Sets what an assistant may do in a space for the people in it: "none",
 * "view" or "edit". Owners only, of a personal space as of a group.
 *
 * Throws a Refusal: 404 when the person is not in the space, 403 when they
 * are not one of its owners.
 */
export function setAssistantLevel(db: Db, request: AssistantLevelRequest): void {
  const { userId, spaceId, level } = request;
  db.transaction(() => {
    const member = membershipOf(db, userId, spaceId);
    if (!member) throw notFound();
    if (member.role !== "owner") {
      throw new Refusal(403, "forbidden", "What an assistant may do in a space is for the space's owners to choose.");
    }
    db.prepare("UPDATE spaces SET assistant = ? WHERE id = ?").run(level, spaceId);
  }).immediate();
}
