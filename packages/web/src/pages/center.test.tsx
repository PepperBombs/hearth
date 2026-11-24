/**
 * The app center (docs/center.md), drawn against a stand-in for the server:
 * "From Hearth", a section for each of the person's groups with what is
 * published there, "Mine" with "Unpublish", in both languages; adding a
 * copy; and the ways in from the Apps page.
 */
import type { AppSummary, CatalogApp, CenterListing, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

const PERSONAL = "space-personal";
const FAMILY = "space-family";
const CLUB = "space-club";

function sessionFor(locale: "en" | "zh" = "en", apps: AppSummary[] = [], familyRole: "owner" | "member" = "owner", groups = true): Session {
  const me = { id: "u1", email: "sam@example.com", name: "Sam Example", locale, theme: "light" as const };
  const member = (role: "owner" | "member") => [
    { id: me.id, name: me.name, role },
    { id: "u2", name: "Lin Example", role: "member" as const },
  ];
  return {
    user: me,
    spaces: [
      { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, assistant: "none", members: [{ id: me.id, name: me.name, role: "owner" }] },
      ...(groups
        ? ([
            { id: FAMILY, kind: "group", name: "Family", role: familyRole, canAddApps: familyRole === "owner", assistant: "none", members: member(familyRole) },
            { id: CLUB, kind: "group", name: "Book club", role: "member", canAddApps: false, assistant: "none", members: member("member") },
          ] as const)
        : []),
    ],
    apps,
    canCreateGroups: false,
    canInvitePeople: false,
    version: "test",
  };
}

const CATALOG: CatalogApp[] = [
  {
    id: "checklist",
    name: { en: "Checklist", zh: "清单" },
    description: { en: "Things to do, ticked off.", zh: "要做的事，做完打勾。" },
    icon: "list-checks",
    color: "teal",
    network: [],
  },
  {
    id: "feed",
    name: { en: "Feed", zh: "动态" },
    description: { en: "News from a sample site.", zh: "来自示例网站的消息。" },
    icon: "newspaper",
    color: "blue",
    network: ["api.example.com"],
  },
];

function listing(id: string, extra: Partial<CenterListing>): CenterListing {
  return {
    id,
    spaceId: FAMILY,
    name: { en: "Ledger", zh: "Ledger" },
    description: { en: "What we spend, by month.", zh: "What we spend, by month." },
    icon: "wallet",
    color: "green",
    collections: [{ name: "expenses", fields: ["amount", "date", "note"] }],
    publishedBy: { id: "u2", name: "Lin Example" },
    revision: 1,
    note: "",
    updatedAt: "2026-11-03T10:00:00.000Z",
    mine: false,
    canUnpublish: true,
    ...extra,
  };
}

/** Lin's ledger in Family, Sam's own reading list there, and Lin's one in the book club, where Sam owns nothing. */
const LISTINGS: CenterListing[] = [
  listing("p-ledger0001", { revision: 2, note: "Totals by month" }),
  listing("p-reading001", {
    name: { en: "Reading list", zh: "Reading list" },
    description: { en: "Books to read next.", zh: "Books to read next." },
    collections: [],
    publishedBy: { id: "u1", name: "Sam Example" },
    mine: true,
  }),
  listing("p-club000001", { spaceId: CLUB, name: { en: "Club picks", zh: "Club picks" }, canUnpublish: false }),
];

type Answer = { status: number; body?: unknown };

/** A copy of a listing in a space, as the session lists it. */
function copyOf(id: string, spaceId: string, listingId: string): AppSummary {
  return {
    id,
    spaceId,
    name: { en: "Ledger", zh: "Ledger" },
    description: { en: "What we spend, by month.", zh: "What we spend, by month." },
    icon: "wallet",
    color: "green",
    widgetSize: "small",
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: true,
    made: true,
    version: 1,
    source: { listingId, by: "Lin Example" },
  };
}

type StartOptions = {
  locale?: "en" | "zh";
  listings?: CenterListing[];
  unpublish?: Answer;
  centerFails?: boolean;
  at?: string;
  /** The apps the session lists at first. */
  apps?: AppSummary[];
  /** Sam's role in Family; a member there may not add apps. */
  familyRole?: "owner" | "member";
  /** How POST .../center/:id is answered; by default a new copy, `m-copy1`, which the session then lists. */
  addCopy?: Answer;
  /** False for a person in no group: the session lists their personal space alone. */
  groups?: boolean;
};

/** Answers the session, the catalog, the center, unpublishing and adding a copy, and records every request with its body. */
function start(options: StartOptions = {}) {
  const requests: string[] = [];
  let listings = options.listings ?? LISTINGS;
  let apps = options.apps ?? [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = String(input);
    requests.push(`${method} ${path}`);
    if (path === "/api/session") return json(sessionFor(options.locale, apps, options.familyRole, options.groups));
    const copied = /^\/api\/spaces\/([^/]+)\/center\/([^/]+)$/.exec(path);
    if (copied && method === "POST") {
      requests[requests.length - 1] += ` ${String(init.body)}`;
      const answer = options.addCopy ?? { status: 201, body: { appId: "m-copy1", restored: false } };
      const appId = (answer.body as { appId?: string } | undefined)?.appId;
      if (answer.status < 300 && appId) apps = [...apps, copyOf(appId, copied[1] ?? "", copied[2] ?? "")];
      return json(answer.body, answer.status);
    }
    if (path === "/api/catalog") return json(CATALOG);
    if (path === "/api/center") return options.centerFails ? json({ error: { code: "internal", message: "Sample failure" } }, 500) : json({ listings });
    const unpublished = /^\/api\/center\/(.+)$/.exec(path);
    if (unpublished && method === "DELETE") {
      const answer = options.unpublish ?? { status: 204 };
      if (answer.status === 204) listings = listings.filter((entry) => entry.id !== unpublished[1]);
      return answer.status === 204 ? new Response(null, { status: 204 }) : json(answer.body, answer.status);
    }
    return json({ error: { code: "not_found", message: "No such route." } }, 404);
  });
  render(
    <MemoryRouter initialEntries={[options.at ?? "/center"]}>
      <App queryClient={new QueryClient()} />
      <Where />
    </MemoryRouter>,
  );
  return requests;
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

const section = async (name: string) => screen.findByRole("region", { name });
const row = (within_: HTMLElement, name: string) => within(within_).getByRole("heading", { level: 3, name }).closest("li") as HTMLElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the app center", () => {
  it("lists the built-in apps, what each group has published, and the person's own", async () => {
    start();
    expect(await screen.findByRole("heading", { level: 1, name: "App center" })).toBeTruthy();

    const hearth = await section("From Hearth");
    expect(await within(hearth).findByText("Checklist")).toBeTruthy();
    expect(within(hearth).getByText("Fetches data from api.example.com on its own.")).toBeTruthy();
    expect(within(hearth).getByRole("link", { name: "the Apps page" }).getAttribute("href")).toBe("/apps");

    const family = await section("In Family");
    const ledger = row(family, "Ledger");
    expect(within(ledger).getByText("By Lin Example, Nov 3")).toBeTruthy();
    expect(within(ledger).getByText("What we spend, by month.")).toBeTruthy();
    expect(within(ledger).getByText("Revision 2: Totals by month")).toBeTruthy();
    expect(within(ledger).getByText("expenses: amount, date, note")).toBeTruthy();
    expect(within(ledger).getByText("It reads and changes only its own entries, and reaches no website.")).toBeTruthy();
    // Sam owns Family, and may unpublish Lin's app there.
    expect(within(ledger).getByRole("button", { name: "Unpublish Ledger from Family" })).toBeTruthy();

    const reading = row(family, "Reading list");
    expect(within(reading).getByText("By you, Nov 3")).toBeTruthy();
    expect(within(reading).getByText("Keeps no entries.")).toBeTruthy();
    // Sam's own is unpublished from "Mine".
    expect(within(reading).queryByRole("button", { name: /Unpublish/ })).toBeNull();

    // In the book club Sam is a member, and unpublishes nothing of Lin's.
    const club = await section("In Book club");
    expect(within(row(club, "Club picks")).queryByRole("button", { name: /Unpublish/ })).toBeNull();

    const mine = await section("Mine");
    expect(within(mine).getAllByRole("listitem")).toHaveLength(1);
    expect(within(mine).getByText("Reading list")).toBeTruthy();
    expect(within(mine).getByText("Family")).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Unpublish Reading list from Family" })).toBeTruthy();
  });

  it("speaks Chinese, and leaves the makers' words as they wrote them", async () => {
    start({ locale: "zh" });
    expect(await screen.findByRole("heading", { level: 1, name: "应用中心" })).toBeTruthy();
    const hearth = await section("Hearth 自带");
    expect(await within(hearth).findByText("清单")).toBeTruthy();
    const family = await section("Family里分享的");
    const ledger = row(family, "Ledger");
    expect(within(ledger).getByText("Lin Example 发布于 11月3日")).toBeTruthy();
    expect(within(ledger).getByText("What we spend, by month.")).toBeTruthy();
    expect(within(ledger).getByText("第 2 版：Totals by month")).toBeTruthy();
    expect(within(ledger).getByText("它只读取和修改自己的条目，不会访问任何网站。")).toBeTruthy();
    expect(within(await section("我发布的")).getByRole("button", { name: "从Family取消发布Reading list" })).toBeTruthy();
  });

  it("says when a group has nothing published, and when the person is in no group", async () => {
    start({ listings: [] });
    expect(await within(await section("In Family")).findByText("Nobody has published an app here yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Mine" })).toBeNull();
    cleanup();

    // In no group, the center says where shared apps would be, with no section of any group and no "Mine".
    start({ listings: [], groups: false });
    expect(await screen.findByText("Apps that people share in a group are listed here. You are in no group yet.")).toBeTruthy();
    expect(await section("From Hearth")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^In / })).toBeNull();
    expect(screen.queryByRole("region", { name: "Mine" })).toBeNull();
    expect(screen.queryByText("Nobody has published an app here yet.")).toBeNull();
    cleanup();

    start({ listings: [], groups: false, locale: "zh" });
    expect(await screen.findByText("群组里的人分享的应用会列在这里。你还没有加入任何群组。")).toBeTruthy();
    expect(screen.queryByText(/Family|Book club/)).toBeNull();
  });

  it("unpublishes after asking, says so, and reads the center and the session again", async () => {
    const requests = start();
    const mine = await section("Mine");
    fireEvent.click(await within(mine).findByRole("button", { name: "Unpublish Reading list from Family" }));
    const dialog = await screen.findByRole("dialog", { name: "Unpublish “Reading list” from Family?" });
    expect(within(dialog).getByText(/Copies already added keep working, with their entries\./)).toBeTruthy();
    requests.length = 0;
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));

    const notice = await screen.findByText("“Reading list” is no longer published. Copies of it keep working.");
    expect(notice.getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(notice));
    expect(screen.queryByRole("region", { name: "Mine" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 3, name: "Reading list" })).toBeNull();
    expect(requests).toContain("DELETE /api/center/p-reading001");
    expect(requests.filter((request) => request.startsWith("GET")).sort()).toEqual(["GET /api/center", "GET /api/session"]);
  });

  it("counts an app someone else unpublished first as unpublished", async () => {
    start({ unpublish: { status: 404, body: { error: { code: "not_found", message: "Sample failure" } } } });
    fireEvent.click(await within(await section("Mine")).findByRole("button", { name: "Unpublish Reading list from Family" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unpublish" }));
    expect(await screen.findByText("“Reading list” is no longer published. Copies of it keep working.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open with the reason when the server refuses", async () => {
    start({ unpublish: { status: 403, body: { error: { code: "forbidden", message: "Sample failure" } } } });
    fireEvent.click(await within(await section("In Family")).findByRole("button", { name: "Unpublish Ledger from Family" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    expect(await within(dialog).findByText("Only its publisher or an owner of the group can unpublish it.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Ledger" })).toBeTruthy();
  });

  it("offers to try again when the center cannot be read, and still lists the built-in apps", async () => {
    start({ centerFails: true });
    expect(await screen.findByText("The app center could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(await within(await section("From Hearth")).findByText("Checklist")).toBeTruthy();
  });
});

describe("adding a copy", () => {
  const openAddDialog = async (app = "Ledger") => {
    fireEvent.click(await within(await section("In Family")).findByRole("button", { name: `Add a copy of ${app}` }));
    return screen.findByRole("dialog", { name: `Add a copy of “${app}”` });
  };

  it("adds one to the personal space, reads the session again, and offers to open it or change it in the chat", async () => {
    const requests = start();
    const dialog = await openAddDialog();
    expect(within(dialog).getByText(/The copy is an app of your own, with no entries yet\./)).toBeTruthy();
    const personal = within(dialog).getByRole("radio", { name: /Personal/ }) as HTMLInputElement;
    expect(personal.checked).toBe(true);
    expect(within(dialog).getByRole("radio", { name: /Family/ })).toBeTruthy();
    // Who else may use it is asked for a group alone.
    expect(within(dialog).queryByRole("group", { name: "Who else can use it" })).toBeNull();
    requests.length = 0;
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const said = await within(dialog).findByText("A copy of “Ledger” is in your personal space now.");
    await waitFor(() => expect(document.activeElement).toBe(said));
    // The session was read again before the copy was offered, so the chat finds it to name.
    expect(requests).toEqual(["POST /api/spaces/space-personal/center/p-ledger0001 {}", "GET /api/session"]);
    expect(within(dialog).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/apps/space-personal/m-copy1");
    expect(within(dialog).getByRole("link", { name: "Change it in the chat" }).getAttribute("href")).toBe(
      "/chat?space=space-personal&app=m-copy1",
    );
    fireEvent.click(within(dialog).getByRole("link", { name: "Open" }));
    expect(screen.getByTestId("where").textContent).toBe("/apps/space-personal/m-copy1");
  });

  it("adds one to the group, asking who else may use it, only me for now first", async () => {
    const requests = start();
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Family/ }));
    const who = within(dialog).getByRole("group", { name: "Who else can use it" });
    expect((within(who).getByRole("radio", { name: "Only me for now" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(who).getByRole("radio", { name: "Everyone can view" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("A copy of “Ledger” is in Family now.")).toBeTruthy();
    expect(requests).toContain('POST /api/spaces/space-family/center/p-ledger0001 {"memberAccess":"view"}');
  });

  it("says which space holds a copy already, with Open, and offers only the others", async () => {
    start({ apps: [copyOf("m-old", PERSONAL, "p-ledger0001"), copyOf("m-other", FAMILY, "p-reading001")] });
    const dialog = await openAddDialog();
    const personal = within(dialog).getByRole("radio", { name: /Personal/ }) as HTMLInputElement;
    expect(personal.disabled).toBe(true);
    expect(within(dialog).getByText("Has a copy already")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Open the copy in your personal space" }).getAttribute("href")).toBe(
      "/apps/space-personal/m-old",
    );
    // A copy of another app in Family is no copy of this one.
    expect((within(dialog).getByRole("radio", { name: /Family/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("offers only the personal space to someone who may not add apps to the group, and says why", async () => {
    start({ familyRole: "member" });
    const dialog = await openAddDialog();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    expect(within(dialog).getByText("Only the owners of Family, and the people they allow, can add apps there.")).toBeTruthy();
  });

  it("keeps the dialog with the reason when the space holds a copy the person cannot see", async () => {
    start({ addCopy: { status: 409, body: { error: { code: "conflict", message: "Sample failure" } } } });
    const dialog = await openAddDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("This space has this app already. If you do not see it, ask an owner of the space.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("says a removed copy came back with its entries, in Chinese too", async () => {
    start({ locale: "zh", addCopy: { status: 200, body: { appId: "m-back", restored: true } } });
    fireEvent.click(await within(await section("Family里分享的")).findByRole("button", { name: "添加Ledger的副本" }));
    const dialog = await screen.findByRole("dialog", { name: "添加「Ledger」的副本" });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    expect(await within(dialog).findByText("「Ledger」的副本已回到你的个人空间，条目都还在。")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "在对话里修改" }).getAttribute("href")).toBe("/chat?space=space-personal&app=m-back");
  });
});

describe("the ways into the app center", () => {
  it("are the Apps page's header and its Add dialog", async () => {
    start({ at: "/apps" });
    await screen.findByRole("heading", { level: 1, name: "Apps" });
    const page = screen.getByRole("main");
    // The sidebar's link, and the one in the Apps page's own header.
    expect(screen.getAllByRole("link", { name: "App center" }).map((link) => link.getAttribute("href"))).toEqual(["/center", "/center"]);

    fireEvent.click((await within(page).findAllByRole("button", { name: "Add an app" }))[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("link", { name: "the app center" }));
    expect(screen.getByTestId("where").textContent).toBe("/center");
    expect(await screen.findByRole("heading", { level: 1, name: "App center" })).toBeTruthy();
  });
});
