/**
 * Who may create groups, and who may let new people onto this server by
 * adding them to a group (owner's decision 4 in docs/mini-app-contract.md).
 *
 * This is the one place that decides it. The session tells the interface
 * what it says (`canCreateGroups`, `canInvitePeople`), and the routes that
 * create a group or invite an address ask it again, so the two cannot
 * disagree. It reads one server setting, `HEARTH_GROUP_POLICY`: "owner",
 * the default, leaves both to the server's owner; "everyone" opens both to
 * every person on the server. Adding someone who is already on the server
 * to a group needs neither: that is for the group's owners.
 */
import type { User } from "@hearth/shared";
import type { Config } from "../config";

export type GroupRights = {
  /** May create a group, and so become the owner of one. */
  canCreateGroups: boolean;
  /** May add an address that is not on this server yet to a group, which lets that person in. */
  canInvitePeople: boolean;
};

export function groupRights(config: Pick<Config, "ownerEmail" | "groupPolicy">, user: Pick<User, "email">): GroupRights {
  // Both addresses are in the one spelling normaliseEmail gives them: the configuration's when it
  // was read, the user's when the user was stored.
  const allowed = config.groupPolicy === "everyone" || user.email === config.ownerEmail;
  return { canCreateGroups: allowed, canInvitePeople: allowed };
}
