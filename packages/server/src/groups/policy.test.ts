/** Who may create groups and invite people (owner's decision 4 in docs/mini-app-contract.md). */
import { describe, expect, it } from "vitest";
import { groupRights } from "./policy";

const OWNER = "owner@example.com";

describe("groupRights", () => {
  it("leaves both to the server's owner by default", () => {
    const config = { ownerEmail: OWNER, groupPolicy: "owner" } as const;
    expect(groupRights(config, { email: OWNER })).toEqual({ canCreateGroups: true, canInvitePeople: true });
    expect(groupRights(config, { email: "lin@example.com" })).toEqual({ canCreateGroups: false, canInvitePeople: false });
  });

  it("opens both to everyone on the server when the setting says so", () => {
    const config = { ownerEmail: OWNER, groupPolicy: "everyone" } as const;
    expect(groupRights(config, { email: "lin@example.com" })).toEqual({ canCreateGroups: true, canInvitePeople: true });
    expect(groupRights(config, { email: OWNER })).toEqual({ canCreateGroups: true, canInvitePeople: true });
  });

  it("does not take an address that only looks like the owner's for the owner's", () => {
    const config = { ownerEmail: OWNER, groupPolicy: "owner" } as const;
    expect(groupRights(config, { email: "owner@example.net" }).canCreateGroups).toBe(false);
    expect(groupRights(config, { email: "owner@example.com.example.net" }).canCreateGroups).toBe(false);
  });
});
