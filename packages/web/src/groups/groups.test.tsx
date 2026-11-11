/**
 * Groups in Settings (build step 10): creating a group, its people, adding
 * someone or inviting them, changing a member's role and right to add apps,
 * removing them, leaving, taking an invitation back, renaming, and the
 * owners' table of who can use each app. The whole web app is drawn against
 * a stand-in for the server that keeps one small family.
 */
import type { AppSummary, MemberAccess, Session, SpaceApps, SpaceRole } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import checklistManifest from "../../../fixture-apps/checklist/manifest";
import feedManifest from "../../../fixture-apps/feed/manifest";
import { App } from "../app";
import { BundledAppsProvider, type BundledApp } from "../apps/bundled";

const PERSONAL = "space-personal";
const FAMILY = "space-family";
const Empty = () => null;
const BUNDLED: readonly BundledApp[] = [
  { id: "checklist", manifest: checklistManifest, hasPage: true, widget: () => Promise.resolve({ default: Empty }) },
  { id: "feed", manifest: feedManifest, hasPage: false, widget: () => Promise.resolve({ default: Empty }) },
];

type Person = { id: string; email: string; name: string };
const SAM: Person = { id: "u1", email: "sam@example.com", name: "Sam Example" };
const LIN: Person = { id: "u2", email: "lin@example.com", name: "Lin Example" };
const KIM: Person = { id: "u3", email: "kim@example.com", name: "Kim Example" };
const NOA: Person = { id: "u4", email: "noa@example.com", name: "Noa Example" };
const PEOPLE = [SAM, LIN, KIM, NOA];

type Member = { id: string; role: SpaceRole; canAddApps: boolean };
type Install = { id: string; memberAccess: MemberAccess; members: Record<string, MemberAccess>; removedAt: string | null; hasCode: boolean };
type Group = { id: string; name: string; members: Member[]; invitations: { email: string; role: SpaceRole; canAddApps: boolean }[]; apps: Install[] };
type Failure = { status: number; code: string };

/**
 * Stands in for the server. Sam is signed in; the family has Sam as its
 * owner, Lin as a member and Kim as a member who may add apps, and two apps.
 * Noa uses the server and is in no group. It answers the session, the
 * routes for groups and members, the owners' list and the access route,
 * and records every change as "METHOD path body".
 */
class FakeServer {
  me: Person = SAM;
  locale: "en" | "zh" = "en";
  canCreateGroups = true;
  canInvitePeople = true;
  groups: Group[] = [
    {
      id: FAMILY,
      name: "Family",
      members: [
        { id: SAM.id, role: "owner", canAddApps: false },
        { id: LIN.id, role: "member", canAddApps: false },
        { id: KIM.id, role: "member", canAddApps: true },
      ],
      invitations: [],
      apps: [
        { id: "checklist", memberAccess: "view", members: { [KIM.id]: "edit" }, removedAt: null, hasCode: true },
        { id: "feed", memberAccess: "none", members: {}, removedAt: null, hasCode: true },
        { id: "journal", memberAccess: "edit", members: {}, removedAt: "2026-01-01T00:00:00.000Z", hasCode: true },
      ],
    },
  ];
  /** Answer requests whose "METHOD path" ends like this with a failure, until cleared. */
  fail: { ending: string; with: Failure } | null = null;
  /** Answer requests whose "METHOD path" ends like this only after a while, as a slow network would. */
  slow: { ending: string; ms: number } | null = null;
  readonly changes: string[] = [];

  person(id: string): Person {
    const found = PEOPLE.find((person) => person.id === id);
    if (!found) throw new Error(`No sample person ${id}`);
    return found;
  }

  session(): Session {
    const me = this.me;
    const mine = this.groups.filter((group) => group.members.some((member) => member.id === me.id));
    const apps: AppSummary[] = [];
    for (const group of mine) {
      const role = group.members.find((member) => member.id === me.id)?.role;
      for (const install of group.apps) {
        const level = role === "owner" ? "edit" : (install.members[me.id] ?? install.memberAccess);
        if (install.removedAt !== null || level === "none") continue;
        const manifest = install.id === "checklist" ? checklistManifest : feedManifest;
        apps.push({
          id: install.id,
          spaceId: group.id,
          name: manifest.name,
          description: manifest.description,
          icon: manifest.icon,
          color: manifest.color,
          widgetSize: manifest.widget.size,
          access: level,
          enabled: true,
          pinned: false,
          hasPage: install.id === "checklist",
        });
      }
    }
    return {
      user: { ...me, locale: this.locale, theme: "light" },
      spaces: [
        { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, members: [{ id: me.id, name: me.name, role: "owner" }] },
        ...mine.map((group) => {
          const mine = group.members.find((member) => member.id === me.id)!;
          return {
            id: group.id,
            kind: "group" as const,
            name: group.name,
            role: mine.role,
            canAddApps: mine.role === "owner" || mine.canAddApps,
            members: group.members.map((member) => ({ id: member.id, name: this.person(member.id).name, role: member.role })),
          };
        }),
      ],
      apps,
      canCreateGroups: this.canCreateGroups,
      canInvitePeople: this.canInvitePeople,
      version: "test",
    };
  }

  ownersList(group: Group): SpaceApps {
    return {
      apps: group.apps.map((install) => ({ ...install, rowCount: 0 })),
      members: group.members.map((member) => ({ ...member, name: this.person(member.id).name, email: this.person(member.id).email })),
      invitations: group.invitations,
    };
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    const method = init.method ?? "GET";
    const body = (typeof init.body === "string" ? JSON.parse(init.body) : undefined) as Record<string, unknown> | undefined;
    if (method !== "GET") this.changes.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    const json = (status: number, value: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const refuse = (status: number, code: string) => json(status, { error: { code, message: "Sample failure" } });
    if (this.fail && `${method} ${path}`.endsWith(this.fail.ending)) return refuse(this.fail.with.status, this.fail.with.code);
    const slow = this.slow;
    if (slow && `${method} ${path}`.endsWith(slow.ending)) await new Promise((resolve) => setTimeout(resolve, slow.ms));

    if (path === "/api/session") return json(200, this.session());
    if (path === "/api/spaces" && method === "POST") {
      if (!this.canCreateGroups) return refuse(403, "forbidden");
      const group: Group = { id: `space-${String(body?.name).toLowerCase().replace(/\W+/g, "-")}`, name: String(body?.name), members: [{ id: this.me.id, role: "owner", canAddApps: false }], invitations: [], apps: [] };
      this.groups.push(group);
      return json(201, this.session().spaces.find((space) => space.id === group.id));
    }

    const match = /^\/api\/spaces\/([^/]+)(?:\/(.+))?$/.exec(path);
    const group = this.groups.find((candidate) => candidate.id === match?.[1]);
    const rest = match?.[2] ?? "";
    const caller = group?.members.find((member) => member.id === this.me.id);
    if (!group || !caller) return refuse(404, "not_found");
    const owner = caller.role === "owner";
    const owners = () => group.members.filter((member) => member.role === "owner").length;

    if (rest === "" && method === "PATCH") {
      if (!owner) return refuse(403, "forbidden");
      group.name = String(body?.name);
      return json(204, null);
    }
    if (rest === "apps" && method === "GET") return owner ? json(200, this.ownersList(group)) : refuse(403, "forbidden");
    if (rest === "members" && method === "POST") {
      if (!owner) return refuse(403, "forbidden");
      const email = String(body?.email).trim().toLowerCase();
      if (!email.includes("@")) return refuse(400, "invalid_request");
      const known = PEOPLE.find((person) => person.email === email);
      const role = (body?.role as SpaceRole | undefined) ?? "member";
      const canAddApps = body?.canAddApps === true;
      if (known) {
        if (group.members.some((member) => member.id === known.id)) return refuse(409, "conflict");
        group.members.push({ id: known.id, role, canAddApps });
        return json(200, { outcome: "added" });
      }
      if (!this.canInvitePeople) return refuse(403, "forbidden");
      if (group.invitations.some((invitation) => invitation.email === email)) return refuse(409, "conflict");
      group.invitations.push({ email, role, canAddApps });
      return json(200, { outcome: "invited" });
    }
    if (rest === "invitations" && method === "DELETE") {
      if (!owner) return refuse(403, "forbidden");
      const before = group.invitations.length;
      group.invitations = group.invitations.filter((invitation) => invitation.email !== body?.email);
      return before === group.invitations.length ? refuse(404, "not_found") : json(204, null);
    }
    const memberMatch = /^members\/(.+)$/.exec(rest);
    const target = group.members.find((member) => member.id === memberMatch?.[1]);
    if (memberMatch && method === "PATCH") {
      if (!owner) return refuse(403, "forbidden");
      if (!target) return refuse(404, "not_found");
      if (body?.role === "member" && target.role === "owner" && owners() === 1) return refuse(409, "conflict");
      if (body?.role !== undefined) target.role = body.role as SpaceRole;
      if (body?.canAddApps !== undefined) target.canAddApps = body.canAddApps === true;
      return json(204, null);
    }
    if (memberMatch && method === "DELETE") {
      if (!target) return refuse(404, "not_found");
      if (target.id !== this.me.id && !owner) return refuse(403, "forbidden");
      if (target.role === "owner" && owners() === 1) return refuse(409, "conflict");
      group.members = group.members.filter((member) => member !== target);
      return json(204, null);
    }
    const accessMatch = /^apps\/([^/]+)\/access$/.exec(rest);
    const install = group.apps.find((candidate) => candidate.id === accessMatch?.[1]);
    if (accessMatch && method === "PUT") {
      if (!install) return refuse(404, "not_found");
      if (!owner) return refuse(403, "forbidden");
      if (body?.memberAccess !== undefined) install.memberAccess = body.memberAccess as MemberAccess;
      for (const [id, level] of Object.entries((body?.members ?? {}) as Record<string, MemberAccess | null>)) {
        if (level === null) delete install.members[id];
        else install.members[id] = level;
      }
      return json(204, null);
    }
    return refuse(404, "not_found");
  };
}

function start(server: FakeServer) {
  vi.stubGlobal("fetch", server.fetch);
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <BundledAppsProvider apps={BUNDLED}>
        <App queryClient={new QueryClient()} />
      </BundledAppsProvider>
    </MemoryRouter>,
  );
}

const main = () => screen.getByRole("main");
/** A card in Settings, once the page is there. */
async function card(name: string): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: /^(Settings|设置)$/ });
  return within(main()).findByRole("region", { name });
}
const dialog = async (name: string) => screen.findByRole("dialog", { name });
/** The people listed in a group's card, as their row says them. */
const peopleIn = (group: HTMLElement) =>
  within(within(group).getByRole("list", { name: /^(People|成员)$/ }))
    .getAllByRole("listitem")
    .map((row) => row.textContent);
const select = (scope: HTMLElement, name: string) => within(scope).getByRole("combobox", { name }) as HTMLSelectElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("groups in Settings", () => {
  it("lets the server's owner create a group, which then has its card", async () => {
    const server = new FakeServer();
    server.groups = [];
    start(server);

    const groups = await card("Groups");
    expect(within(groups).getByText(/A group is a space you share/)).toBeTruthy();
    fireEvent.click(within(groups).getByRole("button", { name: "Create a group" }));
    const create = await dialog("Create a group");
    const confirm = within(create).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(create).getByLabelText("Name"), { target: { value: "  Book club " } });
    fireEvent.click(confirm);

    await waitFor(() => expect(server.changes).toEqual(['POST /api/spaces {"name":"Book club"}']));
    const book = await card("Book club");
    expect(within(book).getByText("You are an owner")).toBeTruthy();
    expect(peopleIn(book)).toEqual(["SSam Example (you)sam@example.comOwner"]);
    expect(within(await card("Groups")).getByText("Book club was created. Add the people who share it.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    // It has no apps yet; the card says where they are added, and leads there.
    const appsPage = await within(book).findByRole("link", { name: "the Apps page" });
    expect(appsPage.closest("p")?.textContent).toBe("No apps in this group yet. Add one on the Apps page.");
    fireEvent.click(appsPage);
    expect(await screen.findByRole("heading", { level: 1, name: "Apps" })).toBeTruthy();
  });

  it("explains groups to someone who may not create one and is in none, and offers no button", async () => {
    const server = new FakeServer();
    server.me = NOA;
    server.canCreateGroups = false;
    server.canInvitePeople = false;
    start(server);

    const groups = await card("Groups");
    expect(within(groups).getByText("You are not in a group yet. When the owner of one adds you, it appears here.")).toBeTruthy();
    expect(within(groups).queryByRole("button")).toBeNull();
  });

  it("shows an owner everyone with their address, and adds someone on the server or invites someone who is not", async () => {
    const server = new FakeServer();
    start(server);

    const family = await card("Family");
    await waitFor(() =>
      expect(peopleIn(family)).toEqual([
        "SSam Example (you)sam@example.comOwner",
        "LLin Examplelin@example.com",
        "KKim Examplekim@example.comCan add apps",
      ]),
    );

    fireEvent.click(within(family).getByRole("button", { name: "Add a person" }));
    let add = await dialog("Add a person to Family");
    expect(within(add).getByText(/is invited, and joins the group when they first open Hearth/)).toBeTruthy();
    fireEvent.change(within(add).getByLabelText("Email address"), { target: { value: " noa@example.com " } });
    fireEvent.click(within(add).getByRole("switch", { name: "Can add apps" }));
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/members {"email":"noa@example.com","role":"member","canAddApps":true}`]));
    expect(await within(family).findByText("noa@example.com was added to the group.")).toBeTruthy();
    await waitFor(() => expect(peopleIn(family).at(-1)).toBe("NNoa Examplenoa@example.comCan add apps"));

    fireEvent.click(within(family).getByRole("button", { name: "Add a person" }));
    add = await dialog("Add a person to Family");
    fireEvent.change(within(add).getByLabelText("Email address"), { target: { value: "pat@example.com" } });
    fireEvent.click(within(add).getByRole("button", { name: "Owner" }));
    // An owner may always add apps, so the switch is not asked.
    expect(within(add).queryByRole("switch")).toBeNull();
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(server.changes[1]).toBe(`POST /api/spaces/${FAMILY}/members {"email":"pat@example.com","role":"owner"}`));
    expect(await within(family).findByText("pat@example.com is invited, and joins the group when they first open Hearth.")).toBeTruthy();
    await waitFor(() => expect(peopleIn(family).at(-1)).toBe("pat@example.comInvitedOwner"));
  });

  it("says why someone could not be added, and keeps the dialog open", async () => {
    const server = new FakeServer();
    server.canInvitePeople = false;
    start(server);

    fireEvent.click(within(await card("Family")).getByRole("button", { name: "Add a person" }));
    const add = await dialog("Add a person to Family");
    expect(within(add).getByText("Only people who already use this server can be added.")).toBeTruthy();
    const email = within(add).getByLabelText("Email address");
    const submit = within(add).getByRole("button", { name: "Add" });

    fireEvent.change(email, { target: { value: "lin@example.com" } });
    fireEvent.click(submit);
    expect(await within(add).findByText("This person is already in the group, or already invited.")).toBeTruthy();

    fireEvent.change(email, { target: { value: "pat@example.com" } });
    fireEvent.click(submit);
    expect(
      await within(add).findByText("Nobody uses this server with this address yet, and only the server's owner can invite new people."),
    ).toBeTruthy();

    fireEvent.change(email, { target: { value: "pat" } });
    fireEvent.click(submit);
    expect(await within(add).findByText("Enter an email address, for example lin@example.com.")).toBeTruthy();
    expect(email.getAttribute("aria-invalid")).toBe("true");
  });

  it("lets an owner make a member an owner, allow them to add apps, and remove them after asking", async () => {
    const server = new FakeServer();
    start(server);
    const family = await card("Family");

    fireEvent.click(await within(family).findByRole("button", { name: "Manage Lin Example" }));
    const manage = await dialog("Lin Example in Family");
    expect(within(manage).getByText("lin@example.com")).toBeTruthy();
    const canAdd = within(manage).getByRole("switch", { name: "Can add apps" });
    fireEvent.click(canAdd);
    await waitFor(() => expect(server.changes).toEqual([`PATCH /api/spaces/${FAMILY}/members/${LIN.id} {"canAddApps":true}`]));
    await waitFor(() => expect(canAdd.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(within(within(manage).getByRole("group", { name: "Role" })).getByRole("button", { name: "Owner" }));
    await waitFor(() => expect(server.changes[1]).toBe(`PATCH /api/spaces/${FAMILY}/members/${LIN.id} {"role":"owner"}`));
    // An owner may always add apps: the switch says so and cannot be changed.
    await waitFor(() => expect((within(manage).getByRole("switch", { name: "Can add apps" }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(manage).getByText("Owners can always add apps.")).toBeTruthy();

    fireEvent.click(within(manage).getByRole("button", { name: "Remove from the group" }));
    const confirm = await dialog("Remove Lin Example from Family?");
    expect(within(confirm).getByText(/What they added stays in the group/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.changes[2]).toBe(`DELETE /api/spaces/${FAMILY}/members/${LIN.id} null`));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(peopleIn(family).some((row) => row?.includes("Lin"))).toBe(false);
  });

  it("does not open someone's dialog by itself when they are added back after being removed", async () => {
    const server = new FakeServer();
    // The owners' list answers after the session, as it does on a real network, where it is asked for second.
    server.slow = { ending: `GET /api/spaces/${FAMILY}/apps`, ms: 50 };
    start(server);
    const family = await card("Family");

    fireEvent.click(await within(family).findByRole("button", { name: "Manage Lin Example" }));
    fireEvent.click(within(await dialog("Lin Example in Family")).getByRole("button", { name: "Remove from the group" }));
    fireEvent.click(within(await dialog("Remove Lin Example from Family?")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(peopleIn(family).some((row) => row?.includes("Lin"))).toBe(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Added again, perhaps after a slip: only the list changes.
    fireEvent.click(within(family).getByRole("button", { name: "Add a person" }));
    const add = await dialog("Add a person to Family");
    fireEvent.change(within(add).getByLabelText("Email address"), { target: { value: "lin@example.com" } });
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(family).findByText("lin@example.com was added to the group.")).toBeTruthy();
    await waitFor(() => expect(peopleIn(family).at(-1)).toBe("LLin Examplelin@example.com"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.changes).toEqual([
      `DELETE /api/spaces/${FAMILY}/members/${LIN.id} null`,
      `POST /api/spaces/${FAMILY}/members {"email":"lin@example.com","role":"member","canAddApps":false}`,
    ]);
  });

  it("does not open an owner's own dialog by itself when they are made an owner again after stepping down", async () => {
    const server = new FakeServer();
    server.groups[0]!.members[1]!.role = "owner";
    start(server);
    const family = await card("Family");

    fireEvent.click(await within(family).findByRole("button", { name: "Manage Sam Example" }));
    fireEvent.click(within(await dialog("Sam Example in Family")).getByRole("button", { name: "Member" }));
    await waitFor(() => expect(within(family).getByText("You are a member")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();

    // An owner again, Sam starts adding someone, but Lin makes Sam a member first: the refusal reloads the session, which says so.
    server.groups[0]!.members[0]!.role = "owner";
    fireEvent.click(within(await card("Groups")).getByRole("button", { name: "Create a group" }));
    fireEvent.change(within(await dialog("Create a group")).getByLabelText("Name"), { target: { value: "Choir" } });
    fireEvent.click(within(await dialog("Create a group")).getByRole("button", { name: "Create" }));
    fireEvent.click(await within(family).findByRole("button", { name: "Add a person" }));
    const add = await dialog("Add a person to Family");
    server.groups[0]!.members[0]!.role = "member";
    fireEvent.change(within(add).getByLabelText("Email address"), { target: { value: "noa@example.com" } });
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(family).getByText("You are a member")).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Lin, the other owner, makes Sam an owner again; Sam's screen learns of it with the next change Sam makes.
    server.groups[0]!.members[0]!.role = "owner";
    fireEvent.click(within(await card("Groups")).getByRole("button", { name: "Create a group" }));
    const create = await dialog("Create a group");
    fireEvent.change(within(create).getByLabelText("Name"), { target: { value: "Book club" } });
    fireEvent.click(within(create).getByRole("button", { name: "Create" }));
    expect(await card("Book club")).toBeTruthy();
    await waitFor(() => expect(within(family).getByText("You are an owner")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tells the last owner to make someone else an owner before stepping down or leaving", async () => {
    const server = new FakeServer();
    start(server);
    const family = await card("Family");

    fireEvent.click(await within(family).findByRole("button", { name: "Manage Sam Example" }));
    const manage = await dialog("Sam Example in Family");
    // Leaving is at the foot of the card, not here.
    expect(within(manage).queryByRole("button", { name: "Remove from the group" })).toBeNull();
    fireEvent.click(within(manage).getByRole("button", { name: "Member" }));
    expect(await within(manage).findByText("A group must keep an owner. Make someone else an owner first.")).toBeTruthy();
    fireEvent.click(within(manage).getByRole("button", { name: "Close" }));

    fireEvent.click(within(family).getByRole("button", { name: "Leave the group" }));
    const leave = await dialog("Leave Family?");
    fireEvent.click(within(leave).getByRole("button", { name: "Leave" }));
    expect(await within(leave).findByText("A group must keep an owner. Make someone else an owner first.")).toBeTruthy();
    expect(server.changes).toEqual([
      `PATCH /api/spaces/${FAMILY}/members/${SAM.id} {"role":"member"}`,
      `DELETE /api/spaces/${FAMILY}/members/${SAM.id} null`,
    ]);
  });

  it("shows an owner who steps down what a member sees, and nothing of the owners' list", async () => {
    const server = new FakeServer();
    server.groups[0]!.members[1]!.role = "owner";
    start(server);
    const family = await card("Family");

    fireEvent.click(await within(family).findByRole("button", { name: "Manage Sam Example" }));
    const manage = await dialog("Sam Example in Family");
    fireEvent.click(within(manage).getByRole("button", { name: "Member" }));
    await waitFor(() => expect(within(family).getByText("You are a member")).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(peopleIn(family)).toEqual(["SSam Example (you)", "LLin ExampleOwner", "KKim Example"]);
    expect(within(family).queryByRole("table")).toBeNull();
    expect(within(family).queryByRole("button", { name: /Manage/ })).toBeNull();
  });

  it("takes an invitation back", async () => {
    const server = new FakeServer();
    server.groups[0]!.invitations = [{ email: "pat@example.com", role: "member", canAddApps: false }];
    start(server);
    const family = await card("Family");

    fireEvent.click(await within(family).findByRole("button", { name: "Take back the invitation for pat@example.com" }));
    await waitFor(() => expect(server.changes).toEqual([`DELETE /api/spaces/${FAMILY}/invitations {"email":"pat@example.com"}`]));
    await waitFor(() => expect(peopleIn(family).some((row) => row?.includes("pat@example.com"))).toBe(false));
  });

  it("renames the group when the field is left", async () => {
    const server = new FakeServer();
    start(server);
    const family = await card("Family");

    const name = within(family).getByLabelText("Name of the group");
    fireEvent.change(name, { target: { value: " The Examples " } });
    fireEvent.blur(name);
    await waitFor(() => expect(server.changes).toEqual([`PATCH /api/spaces/${FAMILY} {"name":"The Examples"}`]));
    expect(await card("The Examples")).toBeTruthy();

    // An empty name is not sent.
    fireEvent.change(within(await card("The Examples")).getByLabelText("Name of the group"), { target: { value: " " } });
    fireEvent.blur(within(await card("The Examples")).getByLabelText("Name of the group"));
    expect(await within(await card("The Examples")).findByText("Enter a name of 1 to 80 characters.")).toBeTruthy();
    expect(server.changes).toHaveLength(1);
  });

  it("shows an owner who can use each app, and saves a choice at once", async () => {
    const server = new FakeServer();
    start(server);
    const family = await card("Family");
    const table = await within(family).findByRole("table", { name: "Who can use each app" });

    // One row per app in the group (the removed one is nobody's), a column for everyone and one per member.
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["App", "Everyone", "Lin Example", "Kim Example"]);
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Checklist", "Feed"]);
    expect(select(table, "Everyone's access to Checklist").value).toBe("view");
    expect(select(table, "Lin Example's access to Checklist").value).toBe("everyone");
    expect(within(select(table, "Lin Example's access to Checklist")).getByRole("option", { name: "As everyone: can view" })).toBeTruthy();
    expect(select(table, "Kim Example's access to Checklist").value).toBe("edit");
    expect(select(table, "Everyone's access to Feed").value).toBe("none");

    fireEvent.change(select(table, "Everyone's access to Checklist"), { target: { value: "edit" } });
    await waitFor(() => expect(server.changes).toEqual([`PUT /api/spaces/${FAMILY}/apps/checklist/access {"memberAccess":"edit"}`]));
    await waitFor(() =>
      expect(within(select(table, "Lin Example's access to Checklist")).getByRole("option", { name: "As everyone: can edit" })).toBeTruthy(),
    );

    fireEvent.change(select(table, "Lin Example's access to Feed"), { target: { value: "view" } });
    fireEvent.change(select(table, "Kim Example's access to Checklist"), { target: { value: "everyone" } });
    await waitFor(() =>
      expect(server.changes.slice(1)).toEqual([
        `PUT /api/spaces/${FAMILY}/apps/feed/access {"members":{"${LIN.id}":"view"}}`,
        `PUT /api/spaces/${FAMILY}/apps/checklist/access {"members":{"${KIM.id}":null}}`,
      ]),
    );
    await waitFor(() => expect(select(table, "Kim Example's access to Checklist").value).toBe("everyone"));
    expect(select(table, "Lin Example's access to Feed").value).toBe("view");
  });

  it("puts a choice back and says so when the server does not save it", async () => {
    const server = new FakeServer();
    server.fail = { ending: "/apps/feed/access", with: { status: 500, code: "internal" } };
    start(server);
    const table = await within(await card("Family")).findByRole("table", { name: "Who can use each app" });

    fireEvent.change(select(table, "Everyone's access to Feed"), { target: { value: "edit" } });
    expect(await within(await card("Family")).findByText("That change could not be saved. Try again.")).toBeTruthy();
    await waitFor(() => expect(select(table, "Everyone's access to Feed").value).toBe("none"));
  });

  it("shows a plain member the people by name alone, and lets them leave", async () => {
    const server = new FakeServer();
    server.me = KIM;
    server.canCreateGroups = false;
    server.canInvitePeople = false;
    start(server);
    const family = await card("Family");

    expect(within(family).getByText("You are a member")).toBeTruthy();
    expect(peopleIn(family)).toEqual(["SSam ExampleOwner", "LLin Example", "KKim Example (you)"]);
    // Allowed to add apps, which is done on the Apps page: the sentence leads there.
    const appsPage = within(family).getByRole("link", { name: "the Apps page" });
    expect(appsPage.closest("p")?.textContent).toBe("You can add apps to this group on the Apps page.");
    expect(appsPage.getAttribute("href")).toBe("/apps");
    for (const name of [/Manage/, "Add a person"]) expect(within(family).queryByRole("button", { name })).toBeNull();
    expect(within(family).queryByRole("table")).toBeNull();
    expect(within(family).queryByLabelText("Name of the group")).toBeNull();
    // A member never asks for the owners' list.
    expect(server.changes).toEqual([]);

    fireEvent.click(within(family).getByRole("button", { name: "Leave the group" }));
    fireEvent.click(within(await dialog("Leave Family?")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(server.changes).toEqual([`DELETE /api/spaces/${FAMILY}/members/${KIM.id} null`]));
    await waitFor(() => expect(within(main()).queryByRole("region", { name: "Family" })).toBeNull());
    // In no group now, and not one who creates them: the card that explains groups is back.
    expect(within(await card("Groups")).getByText(/You are not in a group yet/)).toBeTruthy();
  });

  it("speaks Chinese", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    start(server);
    const family = await card("Family");

    expect(within(family).getByText("你是所有者")).toBeTruthy();
    const table = await within(family).findByRole("table", { name: "每个应用谁可以使用" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["应用", "所有人", "Lin Example", "Kim Example"]);
    expect(select(table, "Lin Example对清单的权限").value).toBe("everyone");
    expect(within(select(table, "Lin Example对清单的权限")).getByRole("option", { name: "同所有人：可查看" })).toBeTruthy();

    fireEvent.click(within(family).getByRole("button", { name: "添加成员" }));
    const add = await dialog("向Family添加成员");
    fireEvent.change(within(add).getByLabelText("电子邮件地址"), { target: { value: "pat@example.com" } });
    fireEvent.click(within(add).getByRole("button", { name: "添加" }));
    expect(await within(family).findByText("已邀请 pat@example.com，对方第一次打开 Hearth 时会加入群组。")).toBeTruthy();
    expect(within(await card("群组")).getByRole("button", { name: "创建群组" })).toBeTruthy();
  });
});
