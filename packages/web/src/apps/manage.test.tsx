/**
 * The Apps page and the settings dialog: adding a built-in app to a space,
 * removing an app, each person's own switch and pin, moving an app to
 * another space, and the settings form the shell draws from what an app
 * declares. The whole web app is drawn with apps made in Hearth, a few
 * built-in apps to add, and a stand-in for the server.
 */
import type { Setting } from "@hearth/sdk";
import type { AppSettings, AppSummary, CatalogApp, Session, SpaceApps } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

const PERSONAL = "space-personal";
const FAMILY = "space-family";

/** A built-in app, as GET /api/catalog lists it, with what an app made from it declares. */
type Sample = CatalogApp & { widgetSize: AppSummary["widgetSize"]; settings?: Record<string, Setting> };

const CHECKLIST: Sample = {
  id: "checklist",
  name: { en: "Checklist", zh: "清单" },
  description: { en: "A list of things to do, ticked off as you go.", zh: "一份待办清单，完成一项勾选一项。" },
  icon: "list-checks",
  color: "teal",
  network: [],
  widgetSize: "tall",
  settings: {
    sections: {
      type: "list",
      scope: "space",
      default: [],
      maxItems: 20,
      maxLength: 40,
      label: { en: "Sections", zh: "分组" },
      help: { en: "Items are grouped in this order.", zh: "事项按此顺序分组。" },
    },
    hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的事项" } },
  },
};

const FEED: Sample = {
  id: "feed",
  name: { en: "Feed", zh: "动态" },
  description: { en: "A card that each person filters for themselves.", zh: "每个人可以自行筛选的卡片。" },
  icon: "trending-up",
  color: "purple",
  network: [],
  widgetSize: "wide",
  settings: {
    topics: {
      type: "multi-select",
      scope: "user",
      default: [],
      options: {
        science: { en: "Science", zh: "科学" },
        sport: { en: "Sport", zh: "体育" },
        food: { en: "Food", zh: "美食" },
      },
      label: { en: "Topics", zh: "主题" },
      help: { en: "Leave empty to follow every topic.", zh: "留空则关注所有主题。" },
    },
    period: {
      type: "select",
      scope: "user",
      default: "day",
      options: { day: { en: "Today", zh: "今天" }, week: { en: "This week", zh: "本周" } },
      label: { en: "Period", zh: "时间范围" },
    },
  },
};

/** An app with the two setting types the others do not have: text and a number. */
const COUNTER: Sample = {
  id: "counter",
  name: { en: "Counter", zh: "计数器" },
  description: { en: "Counts things for you.", zh: "帮你数东西。" },
  icon: "clock",
  color: "amber",
  network: [],
  widgetSize: "small",
  settings: {
    title: { type: "text", scope: "space", default: "Things", maxLength: 20, label: { en: "Title", zh: "标题" } },
    goal: {
      type: "number",
      scope: "user",
      default: 5,
      min: 1,
      max: 10,
      step: 1,
      label: { en: "Daily goal", zh: "每日目标" },
      help: { en: "How many a day.", zh: "每天多少个。" },
    },
  },
};

/** An app that fetches from two hosts, through the server, as its manifest's `network` says. */
const HEADLINES: Sample = {
  id: "headlines",
  name: { en: "Headlines", zh: "头条" },
  description: { en: "The latest headlines from two feeds.", zh: "两个来源的最新头条。" },
  icon: "file-text",
  color: "blue",
  network: ["feeds.example.com", "photos.example.net"],
  widgetSize: "wide",
};

/** The built-in apps the stand-in offers unless a test gives others. */
const BUILT_IN: readonly Sample[] = [CHECKLIST, FEED, COUNTER];
const WITH_HEADLINES: readonly Sample[] = [...BUILT_IN, HEADLINES];

/** An app made in Hearth from a built-in app, in a space, as the session lists it. */
function made(sample: Sample, spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id: `m-${sample.id}`,
    spaceId,
    name: sample.name,
    description: sample.description,
    icon: sample.icon,
    color: sample.color,
    widgetSize: sample.widgetSize,
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: true,
    made: true,
    version: 1,
    template: sample.id,
    ...(sample.settings ? { settings: sample.settings } : {}),
    ...extra,
  };
}

function sessionWith(apps: AppSummary[], options: { locale?: "en" | "zh"; familyRole?: "owner" | "member"; canAdd?: boolean } = {}): Session {
  const me = { id: "u1", email: "sam@example.com", name: "Sam Example", locale: options.locale ?? "en", theme: "light" as const };
  const role = options.familyRole ?? "owner";
  return {
    user: me,
    spaces: [
      { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, assistant: "none", members: [{ id: me.id, name: me.name, role: "owner" }] },
      {
        id: FAMILY,
        kind: "group",
        name: "Family",
        role,
        canAddApps: options.canAdd ?? role === "owner",
        assistant: "none",
        members: [
          { id: me.id, name: me.name, role },
          { id: "u2", name: "Lin Example", role: role === "owner" ? "member" : "owner" },
        ],
      },
    ],
    apps,
    canCreateGroups: false,
    canInvitePeople: false,
    version: "test",
  };
}

type Failure = { status: number; code: string };

/**
 * An app a space removed and kept the data of, as the owners' list counts it,
 * with what it is drawn with; `sample` is what it comes back as, and an
 * entry without one is an install the server holds no app for.
 */
type Removed = { id: string; template?: string; rowCount: number; sample?: Sample };

/** The app made from a built-in app that a space removed, with how many entries it holds. */
const removedFrom = (sample: Sample, rowCount: number): Removed => ({ id: `m-${sample.id}`, template: sample.id, rowCount, sample });

/** An app made in the chat, from no built-in app, that a space removed. */
const removedMade = (sample: Sample, rowCount: number): Removed => ({ id: `m-${sample.id}`, rowCount, sample: { ...sample } });

/** The sample an app the session lists was drawn from, so that removing it keeps what brings it back. */
const sampleOf = (app: AppSummary): Sample => ({
  id: app.id.replace(/^m-/, ""),
  name: app.name,
  description: app.description,
  icon: app.icon,
  color: app.color,
  network: [],
  widgetSize: app.widgetSize,
});

/**
 * Stands in for the server: the session, the built-in apps and adding one
 * to a space, removing and moving apps, switches and pins, settings, and
 * the owners' list of a space, which also has the apps the space removed
 * and kept the data of.
 */
class FakeServer {
  session: Session = sessionWith([]);
  /** The apps shipped with Hearth. */
  catalog: readonly Sample[] = BUILT_IN;
  /** Apps removed from a space whose data was kept, by space ID. */
  removed: Record<string, Removed[]> = {};
  /** How many entries each app in use holds, by app ID (none when not given). */
  rowCounts: Record<string, number> = {};
  /** The settings each app holds, by app ID. */
  settings: Record<string, AppSettings> = {
    "m-checklist": { space: { sections: [] }, user: { hideDone: false } },
    "m-feed": { space: {}, user: { topics: [], period: "day" } },
    "m-counter": { space: { title: "Things" }, user: { goal: 5 } },
  };
  /** Answer requests whose "METHOD path" ends like this with a failure, until cleared. */
  fail: { ending: string; with: Failure } | null = null;
  /** Every request that changes something, as "METHOD path body". */
  readonly changes: string[] = [];
  readonly requests: string[] = [];
  private added = 0;

  count(ending: string): number {
    return this.requests.filter((request) => request.endsWith(ending)).length;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${path}`);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET") this.changes.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    const json = (status: number, value: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (this.fail && `${method} ${path}`.endsWith(this.fail.ending)) {
      return json(this.fail.with.status, { error: { code: this.fail.with.code, message: "Sample failure" } });
    }
    if (path === "/api/session") return json(200, this.session);
    if (path === "/api/catalog") {
      return json(
        200,
        this.catalog.map(({ id, name, description, icon, color, network }) => ({ id, name, description, icon, color, network })),
      );
    }

    // A space has one app made from each built-in app: adding one it removed brings that one back.
    const fromCatalog = /^\/api\/spaces\/([^/]+)\/catalog\/([^/]+)$/.exec(path);
    if (fromCatalog && method === "POST") {
      const [, spaceId = "", templateId = ""] = fromCatalog;
      const sample = this.catalog.find((candidate) => candidate.id === templateId);
      if (!sample) return json(404, { error: { code: "not_found", message: "No such built-in app." } });
      if (this.session.apps.some((app) => app.spaceId === spaceId && app.template === templateId)) {
        return json(409, { error: { code: "conflict", message: "This space has this app already." } });
      }
      const back = (this.removed[spaceId] ?? []).find((entry) => entry.template === templateId);
      this.removed[spaceId] = (this.removed[spaceId] ?? []).filter((entry) => entry !== back);
      const appId = back?.id ?? `m-${templateId}-${++this.added}`;
      this.session = { ...this.session, apps: [...this.session.apps, made(sample, spaceId, { id: appId })] };
      return json(back ? 200 : 201, { appId, restored: back !== undefined });
    }

    const owners = /^\/api\/spaces\/([^/]+)\/apps$/.exec(path);
    if (owners && method === "GET") {
      const space = this.session.spaces.find((candidate) => candidate.id === owners[1]);
      if (!space) return json(404, { error: { code: "not_found", message: "No such space." } });
      if (space.role !== "owner") return json(403, { error: { code: "forbidden", message: "For owners." } });
      return json(200, this.ownersList(space.id));
    }

    const match = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)(?:\/(.+))?$/.exec(path);
    const [, spaceId = "", appId = "", rest = ""] = match ?? [];
    const listed = this.session.apps.find((app) => app.spaceId === spaceId && app.id === appId);
    const kept = (this.removed[spaceId] ?? []).find((entry) => entry.id === appId);
    const owner = this.session.spaces.find((space) => space.id === spaceId)?.role === "owner";

    // Bringing a removed app back, with its data.
    if (rest === "" && method === "PUT" && kept) {
      if (!owner) return json(403, { error: { code: "forbidden", message: "For owners." } });
      if (!kept.sample) return json(404, { error: { code: "not_found", message: "No such app." } });
      this.removed[spaceId] = (this.removed[spaceId] ?? []).filter((entry) => entry !== kept);
      const back = made(kept.sample, spaceId, { id: kept.id, ...(kept.template ? { template: kept.template } : { template: undefined }) });
      this.session = { ...this.session, apps: [...this.session.apps, back] };
      this.rowCounts[kept.id] = kept.rowCount;
      return json(204, null);
    }
    // Deleting an app for good, in use or removed: the name typed must be the app's, in either language.
    if (rest === "data" && method === "DELETE" && (listed || kept)) {
      if (!owner) return json(403, { error: { code: "forbidden", message: "For owners." } });
      const name = listed?.name ?? kept?.sample?.name;
      const confirm = (body as { confirm: string }).confirm.trim();
      const matches = name ? confirm === name.en || confirm === name.zh : confirm === appId;
      if (!matches) return json(400, { error: { code: "invalid_request", message: "Type the app's name." } });
      this.session = { ...this.session, apps: this.session.apps.filter((app) => app !== listed) };
      this.removed[spaceId] = (this.removed[spaceId] ?? []).filter((entry) => entry !== kept);
      return json(204, null);
    }

    if (!listed) return json(404, { error: { code: "not_found", message: "No such app." } });
    if (rest === "" && method === "DELETE") {
      this.session = { ...this.session, apps: this.session.apps.filter((app) => app !== listed) };
      this.removed[spaceId] = [
        ...(this.removed[spaceId] ?? []),
        { id: appId, ...(listed.template ? { template: listed.template } : {}), rowCount: this.rowCounts[appId] ?? 0, sample: sampleOf(listed) },
      ];
      return json(204, null);
    }
    if (rest === "move" && method === "POST") {
      const { toSpaceId } = body as { toSpaceId: string };
      this.session = { ...this.session, apps: this.session.apps.map((app) => (app === listed ? { ...app, spaceId: toSpaceId } : app)) };
      return json(204, null);
    }
    if (rest === "me" && method === "PATCH") {
      this.session = { ...this.session, apps: this.session.apps.map((app) => (app === listed ? { ...app, ...(body as object) } : app)) };
      return json(204, null);
    }
    const settings = this.settings[appId];
    if (rest === "settings" && settings) {
      if (method === "GET") return json(200, settings);
      if (method === "PATCH") {
        const patch = body as Partial<AppSettings>;
        this.settings[appId] = { space: { ...settings.space, ...patch.space }, user: { ...settings.user, ...patch.user } };
        return json(200, this.settings[appId]);
      }
    }
    return json(404, { error: { code: "not_found", message: "No such route." } });
  };

  ownersList(spaceId: string): SpaceApps {
    const space = this.session.spaces.find((candidate) => candidate.id === spaceId);
    const entry = ({ id, template, rowCount, sample }: Removed, removedAt: string | null) => ({
      id,
      ...(template === undefined ? {} : { template }),
      hasCode: sample !== undefined,
      removedAt,
      rowCount,
      memberAccess: "none" as const,
      members: {},
      assistant: true,
      ...(sample ? { name: sample.name, icon: sample.icon, color: sample.color } : {}),
    });
    return {
      apps: [
        ...this.session.apps
          .filter((app) => app.spaceId === spaceId)
          .map((app) =>
            entry({ id: app.id, ...(app.template ? { template: app.template } : {}), rowCount: this.rowCounts[app.id] ?? 0, sample: sampleOf(app) }, null),
          ),
        ...(this.removed[spaceId] ?? []).map((removed) => entry(removed, "2026-11-01T08:00:00.000Z")),
      ],
      members: (space?.members ?? []).map((member) => ({ ...member, email: `${member.id}@example.com`, canAddApps: member.role === "owner" })),
      invitations: [],
    };
  }
}

function start(server: FakeServer, at = "/apps") {
  vi.stubGlobal("fetch", server.fetch);
  render(
    <MemoryRouter initialEntries={[at]}>
      <App queryClient={new QueryClient()} />
    </MemoryRouter>,
  );
}

const main = () => screen.getByRole("main");
/** A space's card on the Apps page, once the page is there. The sidebar has a section of the same name. */
async function spaceCard(name: string): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: /^(Apps|应用)$/ });
  return within(main()).findByRole("region", { name });
}
const dialog = async (name: string) => screen.findByRole("dialog", { name });
const pressed = (element: HTMLElement) => element.getAttribute("aria-pressed") === "true";
const switchedOn = (element: HTMLElement) => element.getAttribute("aria-checked") === "true";
/** The built-in apps the dialog offers, by the ID of each. */
const offered = (add: HTMLElement) =>
  within(within(add).getByRole("group", { name: "App" }))
    .getAllByRole("radio")
    .map((radio) => (radio as HTMLInputElement).value);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Apps page", () => {
  it("is where the empty dashboard leads", async () => {
    const server = new FakeServer();
    start(server, "/");

    expect(await screen.findByRole("heading", { name: "No widgets yet" })).toBeTruthy();
    fireEvent.click(within(main()).getByRole("link", { name: "Go to the Apps page" }));
    expect(await within(await spaceCard("Personal")).findByRole("button", { name: "Add an app" })).toBeTruthy();
  });

  it("lists every app by space, switched-off ones included, with the person's own controls", async () => {
    const server = new FakeServer();
    server.session = sessionWith([
      made(CHECKLIST, PERSONAL),
      made(FEED, PERSONAL, { enabled: false }),
      made(CHECKLIST, FAMILY, { id: "m-checklist-family", access: "view", pinned: true }),
    ]);
    start(server);

    const personal = await spaceCard("Personal");
    expect(within(personal).getByRole("switch", { name: "Show Checklist" }).getAttribute("aria-checked")).toBe("true");
    expect(within(personal).getByRole("switch", { name: "Show Feed" }).getAttribute("aria-checked")).toBe("false");
    expect(within(personal).getByText(/Switched off/)).toBeTruthy();
    // A switched-off app has no link to its page; one that is on does.
    expect(within(personal).getByRole("link", { name: "Checklist" }).getAttribute("href")).toBe(`/apps/${PERSONAL}/m-checklist`);
    expect(within(personal).queryByRole("link", { name: "Feed" })).toBeNull();

    const family = await spaceCard("Family");
    expect(within(family).getByText("View only")).toBeTruthy();
    expect(pressed(within(family).getByRole("button", { name: "Pin Checklist in Family" }))).toBe(true);
    // The pinned one is a shortcut at the top too.
    const pinned = within(main()).getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("link", { name: "Checklist in Family" }).getAttribute("href")).toBe(`/apps/${FAMILY}/m-checklist-family`);
  });

  it("switches an app off for this person, which takes it off the dashboard, and on again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL), made(FEED, PERSONAL)]);
    start(server);

    const personal = await spaceCard("Personal");
    const show = within(personal).getByRole("switch", { name: "Show Feed" });
    fireEvent.click(show);
    // Saved by the server, and the session read again.
    await waitFor(() => expect(switchedOn(show)).toBe(false));
    await waitFor(() => expect(server.changes).toEqual([`PATCH /api/spaces/${PERSONAL}/apps/m-feed/me {"enabled":false}`]));
    await waitFor(() => expect(server.count("GET /api/session")).toBe(2));

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    const grid = await screen.findByTestId("widget-grid");
    expect(within(grid).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Checklist"]);

    fireEvent.click(screen.getAllByRole("link", { name: "Apps" })[0] as HTMLElement);
    fireEvent.click(within(await spaceCard("Personal")).getByRole("switch", { name: "Show Feed" }));
    await waitFor(() => expect(server.changes).toHaveLength(2));
    expect(server.changes[1]).toBe(`PATCH /api/spaces/${PERSONAL}/apps/m-feed/me {"enabled":true}`);
  });

  it("pins an app: it joins the shortcuts and comes first on the dashboard", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL), made(CHECKLIST, PERSONAL)]);
    start(server);

    const personal = await spaceCard("Personal");
    expect(within(main()).getByText("Nothing pinned yet.")).toBeTruthy();
    fireEvent.click(within(personal).getByRole("button", { name: "Pin Checklist" }));
    await waitFor(() => expect(server.changes).toEqual([`PATCH /api/spaces/${PERSONAL}/apps/m-checklist/me {"pinned":true}`]));
    const pinned = within(main()).getByRole("region", { name: "Pinned" });
    expect(await within(pinned).findByRole("link", { name: "Checklist" })).toBeTruthy();
    // Pinned apps are listed first in their space as well.
    const rows = within(await spaceCard("Personal")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-app-row"))).toEqual(["m-checklist", "m-feed"]);

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    const grid = await screen.findByTestId("widget-grid");
    expect(within(grid).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Checklist", "Feed"]);
  });

  it("puts the switch back and says so when the server does not save it", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL)]);
    server.fail = { ending: "/m-feed/me", with: { status: 500, code: "internal" } };
    start(server);

    const personal = await spaceCard("Personal");
    fireEvent.click(within(personal).getByRole("switch", { name: "Show Feed" }));
    expect(await within(personal).findByText("That change could not be saved. Try again.")).toBeTruthy();
    await waitFor(() => expect(switchedOn(within(personal).getByRole("switch", { name: "Show Feed" }))).toBe(true));
  });

  it("adds a built-in app to the personal space as an app of its own, without asking about anyone else", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL)]);
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    // The checklist is there already; the others are offered, the first one chosen.
    expect(offered(add)).toEqual(["feed", "counter"]);
    expect((within(add).getByRole("radio", { name: /Feed/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(add).queryByRole("group", { name: "Who else can use it" })).toBeNull();
    fireEvent.click(within(add).getByRole("radio", { name: /Counter/ }));
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${PERSONAL}/catalog/counter {}`]));
    expect(await within(await spaceCard("Personal")).findByRole("switch", { name: "Show Counter" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Added, it is not offered again.
    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    expect(offered(await dialog("Add an app to your personal space"))).toEqual(["feed"]);
  });

  it("offers each built-in app to each space, whatever the other spaces have", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL), made(FEED, FAMILY)]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    expect(offered(await dialog("Add an app to Family"))).toEqual(["checklist", "counter"]);
  });

  it("asks who else may use an app added to a group, with only me for now chosen first", async () => {
    const server = new FakeServer();
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to Family");
    const who = within(add).getByRole("group", { name: "Who else can use it" });
    expect((within(who).getByRole("radio", { name: "Only me for now" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(who).getByRole("radio", { name: "Everyone can edit" }));
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/catalog/checklist {"memberAccess":"edit"}`]));
  });

  it("says when an app cannot be added, and keeps the dialog open", async () => {
    const server = new FakeServer();
    server.session = sessionWith([], { familyRole: "member", canAdd: true });
    server.fail = { ending: `POST /api/spaces/${FAMILY}/catalog/checklist`, with: { status: 409, code: "conflict" } };
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to Family");
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("This app cannot be added here. Ask an owner of the space.")).toBeTruthy();
    // A member who may add apps does not read the owners' list; the server turns down what is not theirs to add.
    expect(server.count(`GET /api/spaces/${FAMILY}/apps`)).toBe(0);
  });

  it("says that adding a built-in app the space removed brings its data back, and still asks who else may use it", async () => {
    const server = new FakeServer();
    server.removed[FAMILY] = [removedFrom(CHECKLIST, 3)];
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to Family");
    expect(await within(add).findByText("Removed earlier: adding it again brings back its data, 3 saved entries.")).toBeTruthy();
    const checklist = within(add).getByRole("radio", { name: /Checklist/ }) as HTMLInputElement;
    expect(checklist.checked).toBe(true);
    expect(within(add).getByRole("button", { name: "Bring back" })).toBeTruthy();
    const who = within(add).getByRole("group", { name: "Who else can use it" });
    expect((within(who).getByRole("radio", { name: "Only me for now" }) as HTMLInputElement).checked).toBe(true);
    // An app the space never had is added as before.
    fireEvent.click(within(add).getByRole("radio", { name: /Feed/ }));
    expect(within(add).getByRole("button", { name: "Add" })).toBeTruthy();
    expect(within(add).queryByRole("button", { name: "Bring back" })).toBeNull();

    fireEvent.click(checklist);
    fireEvent.click(within(who).getByRole("radio", { name: "Everyone can view" }));
    fireEvent.click(within(add).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/catalog/checklist {"memberAccess":"view"}`]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The app that comes back is the one the space removed.
    const family = await spaceCard("Family");
    expect(within(family).getByRole("switch", { name: "Show Checklist in Family" })).toBeTruthy();
    expect(within(family).getByRole("link", { name: "Checklist in Family" }).getAttribute("href")).toBe(`/apps/${FAMILY}/m-checklist`);
  });

  it("counts what comes back, and says when it is only the settings", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [removedFrom(CHECKLIST, 1), removedFrom(FEED, 0)];
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    expect(await within(add).findByText("Removed earlier: adding it again brings back its data, 1 saved entry.")).toBeTruthy();
    expect(within(add).getByText("Removed earlier: adding it again brings back its settings.")).toBeTruthy();
    // The counter was never here.
    expect(within(add).getByRole("radio", { name: /Counter/ }).closest("label")?.textContent).not.toMatch(/Removed earlier/);
  });

  it("does not take an app made in the chat that the space removed for a built-in one", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [{ id: "m-ledger", rowCount: 4 }];
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    // Adding waits for the owners' list, which is there once the button can be pressed.
    await waitFor(() => expect((within(add).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(false));
    expect(offered(add)).toEqual(["checklist", "feed", "counter"]);
    expect(within(add).queryByText(/Removed earlier/)).toBeNull();
    expect(within(add).getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("adds nothing for an owner until it knows which apps the space removed, and offers to look again", async () => {
    const server = new FakeServer();
    server.fail = { ending: `GET /api/spaces/${PERSONAL}/apps`, with: { status: 500, code: "internal" } };
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    expect(await within(add).findByText("Whether these apps were in this space before could not be checked.")).toBeTruthy();
    expect((within(add).getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);

    server.fail = null;
    server.removed[PERSONAL] = [removedFrom(CHECKLIST, 2)];
    fireEvent.click(within(add).getByRole("button", { name: "Try again" }));
    expect(await within(add).findByText("Removed earlier: adding it again brings back its data, 2 saved entries.")).toBeTruthy();
    expect((within(add).getByRole("button", { name: "Bring back" }) as HTMLButtonElement).disabled).toBe(false);
    expect(server.changes).toEqual([]);
  });

  it("reads the session again when adding is turned down, and tells an owner that the app may be here already", async () => {
    const server = new FakeServer();
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to Family");
    // Meanwhile another owner added the checklist to the family: the server turns a second one down.
    server.session = sessionWith([made(CHECKLIST, FAMILY)]);
    const sessions = server.count("GET /api/session");
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));

    expect(
      await within(add).findByText("The app could not be added: it may have been added here meanwhile. This page now shows what the space has."),
    ).toBeTruthy();
    expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/catalog/checklist {"memberAccess":"none"}`]);
    expect(server.count("GET /api/session")).toBe(sessions + 1);
    // The family has the checklist now, so it is no longer offered, and the next app is chosen instead.
    expect(within(add).queryByRole("radio", { name: /Checklist/ })).toBeNull();
    expect((within(add).getByRole("radio", { name: /Feed/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(await spaceCard("Family")).getByRole("switch", { name: "Show Checklist in Family" })).toBeTruthy();
  });

  it("closes the dialog when someone else added the last app it offered", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL), made(FEED, PERSONAL)]);
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    expect(offered(add)).toEqual(["counter"]);
    server.session = sessionWith([made(CHECKLIST, PERSONAL), made(FEED, PERSONAL), made(COUNTER, PERSONAL)]);
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const personal = await spaceCard("Personal");
    expect(within(personal).getByText(/^Every built-in app is already here\./)).toBeTruthy();

    // Removed again, the counter can be added again; the dialog waits to be asked for.
    fireEvent.click(within(personal).getByRole("button", { name: "Remove Counter" }));
    fireEvent.click(within(await dialog("Remove Counter?")).getByRole("button", { name: "Remove" }));
    expect(await within(personal).findByRole("button", { name: "Add an app" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when the server no longer holds the app asked for", async () => {
    const server = new FakeServer();
    server.fail = { ending: `POST /api/spaces/${PERSONAL}/catalog/checklist`, with: { status: 404, code: "not_found" } };
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    fireEvent.click(await within(add).findByRole("button", { name: "Add" }));
    expect(await within(add).findByText("This server no longer holds this app. Reload the page to update.")).toBeTruthy();
  });

  it("says why there is nothing to add: no built-in apps, or every one here already, and leads to the chat", async () => {
    const server = new FakeServer();
    server.catalog = [];
    start(server);
    const personal = await spaceCard("Personal");
    const none = await within(personal).findByText(/^This server has no built-in apps\./);
    expect(none.textContent).toBe("This server has no built-in apps. Make an app in the chat.");
    expect(within(none).getByRole("link", { name: "the chat" }).getAttribute("href")).toBe("/chat");
    expect(within(personal).queryByRole("button", { name: "Add an app" })).toBeNull();
    expect(within(await spaceCard("Family")).getByText(/^This server has no built-in apps\./)).toBeTruthy();

    cleanup();
    server.catalog = BUILT_IN;
    server.session = sessionWith([made(CHECKLIST, PERSONAL), made(FEED, PERSONAL), made(COUNTER, PERSONAL)]);
    start(server);
    const full = await within(await spaceCard("Personal")).findByText(/^Every built-in app is already here\./);
    expect(full.textContent).toBe("Every built-in app is already here. Make a new one in the chat.");
    fireEvent.click(within(full).getByRole("link", { name: "the chat" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Chat" })).toBeTruthy();
  });

  it("says when the built-in apps could not be read, and reads them again", async () => {
    const server = new FakeServer();
    server.fail = { ending: "GET /api/catalog", with: { status: 500, code: "internal" } };
    start(server);

    const personal = await spaceCard("Personal");
    expect(await within(personal).findByText("The built-in apps could not be loaded.")).toBeTruthy();
    expect(within(personal).queryByRole("button", { name: "Add an app" })).toBeNull();
    // What the server failed at is not asked again by itself.
    expect(server.count("GET /api/catalog")).toBe(1);

    server.fail = null;
    fireEvent.click(within(personal).getByRole("button", { name: "Try again" }));
    expect(await within(personal).findByRole("button", { name: "Add an app" })).toBeTruthy();
    expect(within(personal).queryByText("The built-in apps could not be loaded.")).toBeNull();
  });

  it("offers adding only where the person may, and removing only to an owner", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY, { access: "edit" })], { familyRole: "member" });
    start(server);

    const family = await spaceCard("Family");
    expect(within(family).queryByRole("button", { name: "Add an app" })).toBeNull();
    expect(within(family).queryByRole("button", { name: /Remove/ })).toBeNull();
    // Pin and switch are everyone's own.
    expect(within(family).getByRole("button", { name: "Pin Checklist in Family" })).toBeTruthy();
    expect(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" })).toBeTruthy();
  });

  it("takes an app someone else removed off the page when removing it is turned down", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY), made(FEED, FAMILY)]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Feed in Family" }));
    const remove = await dialog("Remove Feed in Family?");
    // Meanwhile another owner removed it.
    server.session = sessionWith([made(CHECKLIST, FAMILY)]);
    fireEvent.click(within(remove).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const family = await spaceCard("Family");
    expect(within(family).queryByRole("switch", { name: "Show Feed in Family" })).toBeNull();
    expect(within(family).getByRole("switch", { name: "Show Checklist in Family" })).toBeTruthy();
    expect(server.changes).toEqual([`DELETE /api/spaces/${FAMILY}/apps/m-feed null`]);
  });

  it("tells someone who is no longer an owner that removing is for owners", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Checklist in Family" }));
    const remove = await dialog("Remove Checklist in Family?");
    // Meanwhile another owner made Sam a plain member.
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { familyRole: "member" });
    server.fail = { ending: `DELETE /api/spaces/${FAMILY}/apps/m-checklist`, with: { status: 403, code: "forbidden" } };
    fireEvent.click(within(remove).getByRole("button", { name: "Remove" }));
    expect(await within(remove).findByText("Only an owner of this space can remove an app.")).toBeTruthy();
    expect(within(await spaceCard("Family")).queryByRole("button", { name: "Remove Checklist in Family" })).toBeNull();
  });

  it("removes an app from a space after asking, and says that its data is kept", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Checklist in Family" }));
    const remove = await dialog("Remove Checklist in Family?");
    expect(within(remove).getByText(/Its data is kept/)).toBeTruthy();
    fireEvent.click(within(remove).getByRole("button", { name: "Cancel" }));
    expect(server.changes).toEqual([]);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Checklist in Family" }));
    fireEvent.click(within(await dialog("Remove Checklist in Family?")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.changes).toEqual([`DELETE /api/spaces/${FAMILY}/apps/m-checklist null`]));
    expect(await within(await spaceCard("Family")).findByText("No apps in this space yet.")).toBeTruthy();
  });

  it("says that an app made in the chat can be brought back from Removed apps, and a built-in one also by adding it again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY, { template: undefined }), made(FEED, FAMILY)]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Checklist in Family" }));
    const remove = await dialog("Remove Checklist in Family?");
    expect(within(remove).getByText(/Its data is kept: an owner can bring it back from Removed apps on this page\./)).toBeTruthy();
    expect(within(remove).queryByText(/cannot be added back/)).toBeNull();
    fireEvent.click(within(remove).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Feed in Family" }));
    expect(within(await dialog("Remove Feed in Family?")).getByText(/bring it back from Removed apps on this page, or add it again/)).toBeTruthy();
  });

  it("speaks Chinese", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { locale: "zh" });
    server.removed[FAMILY] = [removedFrom(FEED, 2)];
    start(server);
    const family = await spaceCard("Family");
    expect(within(family).getByRole("switch", { name: "显示Family的清单" })).toBeTruthy();
    fireEvent.click(within(family).getByRole("button", { name: "添加应用" }));
    const add = await dialog("向Family添加应用");
    expect(within(add).getByRole("radio", { name: "暂时只有我" })).toBeTruthy();
    expect(await within(add).findByText("曾被移除：再次添加会恢复它的数据，共 2 条。")).toBeTruthy();
    expect(within(add).getByRole("button", { name: "恢复" })).toBeTruthy();
  });

  it("says why there is nothing to add in Chinese too", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL), made(FEED, PERSONAL), made(COUNTER, PERSONAL)], { locale: "zh" });
    start(server);
    const full = await within(await spaceCard("个人")).findByText(/^内置应用都已经在这里了。/);
    expect(full.textContent).toBe("内置应用都已经在这里了。可以在对话里做一个新的。");
    expect(within(full).getByRole("link", { name: "对话" }).getAttribute("href")).toBe("/chat");
  });
});

/** An app made in the chat, from no built-in app. */
const LEDGER: Sample = {
  id: "ledger",
  name: { en: "Ledger", zh: "Ledger" },
  description: { en: "What I spend each day.", zh: "What I spend each day." },
  icon: "wallet",
  color: "green",
  network: [],
  widgetSize: "wide",
};

describe("removed apps, bringing them back and deleting for good", () => {
  /** A space's "Removed apps", once the owners' list is there. */
  const removedList = async (space: string) => within(await spaceCard(space)).findByRole("list", { name: "Removed apps" });
  const deleteButton = (box: HTMLElement) => within(box).getByRole("button", { name: "Delete" }) as HTMLButtonElement;

  it("lists each space's removed apps for its owners, with icon, name and entries, and nothing for a member", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { familyRole: "member" });
    server.removed[PERSONAL] = [removedMade(LEDGER, 12), removedFrom(FEED, 1), { id: "old-notes", rowCount: 0 }];
    server.removed[FAMILY] = [removedFrom(COUNTER, 3)];
    start(server);

    const list = await removedList("Personal");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-removed-app"))).toEqual(["m-ledger", "m-feed", "old-notes"]);
    expect(within(rows[0]!).getByText("Ledger")).toBeTruthy();
    expect(within(rows[0]!).getByText("12 entries")).toBeTruthy();
    expect(rows[0]!.querySelector("svg")).toBeTruthy();
    expect(within(rows[1]!).getByText("1 entry")).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "Bring back Ledger" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "Delete permanently: Ledger" })).toBeTruthy();
    // An install the server holds no app for goes by its ID, and can only be deleted.
    expect(within(rows[2]!).getByText("No entries")).toBeTruthy();
    expect(within(rows[2]!).queryByRole("button", { name: /Bring back/ })).toBeNull();
    expect(within(rows[2]!).getByRole("button", { name: "Delete permanently: old-notes" })).toBeTruthy();

    // Sam is a member of Family: no list of what it removed, which is for its owners.
    const family = await spaceCard("Family");
    expect(within(family).queryByRole("list", { name: "Removed apps" })).toBeNull();
    expect(server.requests).not.toContain(`GET /api/spaces/${FAMILY}/apps`);
  });

  it("shows no section where nothing was removed", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL)]);
    start(server);
    const personal = await spaceCard("Personal");
    await waitFor(() => expect(server.requests).toContain(`GET /api/spaces/${PERSONAL}/apps`));
    expect(within(personal).queryByText("Removed apps")).toBeNull();
  });

  it("brings an app made in the chat back to the personal space, with its data, and says so", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [removedMade(LEDGER, 12)];
    start(server);

    fireEvent.click(within(await removedList("Personal")).getByRole("button", { name: "Bring back Ledger" }));
    const back = await dialog("Bring back Ledger?");
    expect(within(back).getByText("It comes back with its data, 12 saved entries, and its settings.")).toBeTruthy();
    // In a personal space there is nobody else to ask about.
    expect(within(back).queryByRole("radio")).toBeNull();
    fireEvent.click(within(back).getByRole("button", { name: "Bring back" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const personal = await spaceCard("Personal");
    expect(await within(personal).findByRole("switch", { name: "Show Ledger" })).toBeTruthy();
    expect(within(personal).queryByRole("list", { name: "Removed apps" })).toBeNull();
    const notice = within(personal).getByRole("status");
    expect(notice.textContent).toBe("Ledger is back.");
    expect(document.activeElement).toBe(notice);
    expect(server.changes).toEqual([`PUT /api/spaces/${PERSONAL}/apps/m-ledger {}`]);
  });

  it("asks who else may use an app brought back to a group, only me for now first", async () => {
    const server = new FakeServer();
    server.session = sessionWith([]);
    server.removed[FAMILY] = [removedFrom(CHECKLIST, 1)];
    start(server);

    fireEvent.click(within(await removedList("Family")).getByRole("button", { name: "Bring back Checklist in Family" }));
    const back = await dialog("Bring back Checklist in Family?");
    expect(within(back).getByText("It comes back with its data, 1 saved entry, and its settings.")).toBeTruthy();
    expect((within(back).getByRole("radio", { name: "Only me for now" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(back).getByRole("radio", { name: "Everyone can view" }));
    fireEvent.click(within(back).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(server.changes).toEqual([`PUT /api/spaces/${FAMILY}/apps/m-checklist {"memberAccess":"view"}`]));
    expect(await within(await spaceCard("Family")).findByRole("switch", { name: "Show Checklist in Family" })).toBeTruthy();
  });

  it("shows a built-in app the space removed here too, as the Add dialog still offers it", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [removedFrom(FEED, 0)];
    start(server);
    expect(within(await removedList("Personal")).getByRole("button", { name: "Bring back Feed" })).toBeTruthy();
    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    expect(await within(await dialog("Add an app to your personal space")).findByText(/Removed earlier/)).toBeTruthy();
  });

  it("says when bringing back is turned down, keeps the dialog and reads the page again", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [removedMade(LEDGER, 2)];
    start(server);

    fireEvent.click(within(await removedList("Personal")).getByRole("button", { name: "Bring back Ledger" }));
    const back = await dialog("Bring back Ledger?");
    server.fail = { ending: `PUT /api/spaces/${PERSONAL}/apps/m-ledger`, with: { status: 409, code: "conflict" } };
    const before = server.count(`GET /api/spaces/${PERSONAL}/apps`);
    fireEvent.click(within(back).getByRole("button", { name: "Bring back" }));
    expect(await within(back).findByText(/could not be brought back: it may have been brought back or deleted meanwhile/)).toBeTruthy();
    expect(server.count(`GET /api/spaces/${PERSONAL}/apps`)).toBeGreaterThan(before);

    server.fail = { ending: `PUT /api/spaces/${PERSONAL}/apps/m-ledger`, with: { status: 500, code: "internal" } };
    fireEvent.click(within(back).getByRole("button", { name: "Bring back" }));
    expect(await within(back).findByText("The app could not be brought back. Try again.")).toBeTruthy();
  });

  it("deletes a removed app for good only once its name is typed, and says how much goes and that it cannot be undone", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)]);
    server.removed[FAMILY] = [removedMade(LEDGER, 12)];
    start(server);

    fireEvent.click(within(await removedList("Family")).getByRole("button", { name: "Delete permanently: Ledger in Family" }));
    const box = await dialog("Delete Ledger for good?");
    expect(
      within(box).getByText("Its 12 entries, its settings and its versions are deleted for everyone in Family. This cannot be undone."),
    ).toBeTruthy();
    const typed = within(box).getByRole("textbox", { name: "Type “Ledger” to confirm" });
    expect(deleteButton(box).disabled).toBe(true);
    fireEvent.change(typed, { target: { value: "ledger" } });
    expect(deleteButton(box).disabled).toBe(true);
    fireEvent.change(typed, { target: { value: "Ledge" } });
    expect(deleteButton(box).disabled).toBe(true);
    // Pressing Enter in the box sends nothing while the name does not match.
    fireEvent.submit(typed.closest("form")!);
    expect(server.changes).toEqual([]);

    fireEvent.change(typed, { target: { value: "  Ledger " } });
    expect(deleteButton(box).disabled).toBe(false);
    fireEvent.click(deleteButton(box));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.changes).toEqual([`DELETE /api/spaces/${FAMILY}/apps/m-ledger/data {"confirm":"Ledger"}`]);
    const family = await spaceCard("Family");
    expect(within(family).queryByRole("list", { name: "Removed apps" })).toBeNull();
    const notice = within(family).getByRole("status");
    expect(notice.textContent).toBe("Ledger was deleted.");
    expect(document.activeElement).toBe(notice);
    // The app in use is untouched.
    expect(within(family).getByRole("switch", { name: "Show Checklist in Family" })).toBeTruthy();
  });

  it("takes the name in either of its languages", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [removedFrom(COUNTER, 1)];
    start(server);
    fireEvent.click(within(await removedList("Personal")).getByRole("button", { name: "Delete permanently: Counter" }));
    const box = await dialog("Delete Counter for good?");
    expect(within(box).getByText("Its 1 entry, its settings and its versions are deleted. This cannot be undone.")).toBeTruthy();
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "计数器" } });
    fireEvent.click(deleteButton(box));
    await waitFor(() => expect(server.changes).toEqual([`DELETE /api/spaces/${PERSONAL}/apps/m-counter/data {"confirm":"计数器"}`]));
  });

  it("deletes an install the server holds no app for by its ID", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [{ id: "old-notes", rowCount: 0 }];
    start(server);
    fireEvent.click(within(await removedList("Personal")).getByRole("button", { name: "Delete permanently: old-notes" }));
    const box = await dialog("Delete old-notes for good?");
    expect(within(box).getByText("Its settings and versions are deleted. This cannot be undone.")).toBeTruthy();
    fireEvent.change(within(box).getByRole("textbox", { name: "Type “old-notes” to confirm" }), { target: { value: "old-notes" } });
    fireEvent.click(deleteButton(box));
    await waitFor(() => expect(server.changes).toEqual([`DELETE /api/spaces/${PERSONAL}/apps/old-notes/data {"confirm":"old-notes"}`]));
  });

  it("deletes an app in use for good from its Remove dialog, for an owner, with how many entries go", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL, { template: undefined }), made(FEED, PERSONAL)]);
    server.rowCounts["m-checklist"] = 7;
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Remove Checklist" }));
    const remove = await dialog("Remove Checklist?");
    fireEvent.click(within(remove).getByRole("button", { name: "Delete permanently" }));
    const box = await dialog("Delete Checklist for good?");
    expect(screen.queryByRole("dialog", { name: "Remove Checklist?" })).toBeNull();
    expect(await within(box).findByText("Its 7 entries, its settings and its versions are deleted. This cannot be undone.")).toBeTruthy();
    fireEvent.change(within(box).getByRole("textbox", { name: "Type “Checklist” to confirm" }), { target: { value: "Checklist" } });
    fireEvent.click(deleteButton(box));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.changes).toEqual([`DELETE /api/spaces/${PERSONAL}/apps/m-checklist/data {"confirm":"Checklist"}`]);
    const personal = await spaceCard("Personal");
    expect(within(personal).queryByRole("switch", { name: "Show Checklist" })).toBeNull();
    expect(within(personal).getByRole("switch", { name: "Show Feed" })).toBeTruthy();
    expect(within(personal).getByRole("status").textContent).toBe("Checklist was deleted.");
  });

  it("offers deleting for good only to an owner: a member has no Remove dialog at all", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { familyRole: "member" });
    start(server);
    const family = await spaceCard("Family");
    expect(within(family).queryByRole("button", { name: /Delete permanently/ })).toBeNull();
    expect(within(family).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("deletes nothing until it knows how many entries go, and offers to look again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL)]);
    server.fail = { ending: `GET /api/spaces/${PERSONAL}/apps`, with: { status: 500, code: "internal" } };
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Remove Checklist" }));
    fireEvent.click(within(await dialog("Remove Checklist?")).getByRole("button", { name: "Delete permanently" }));
    const box = await dialog("Delete Checklist for good?");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Checklist" } });
    expect(await within(box).findByText("How many entries it holds could not be read.")).toBeTruthy();
    expect(deleteButton(box).disabled).toBe(true);

    server.fail = null;
    fireEvent.click(within(box).getByRole("button", { name: "Try again" }));
    expect(await within(box).findByText("Its settings and versions are deleted. This cannot be undone.")).toBeTruthy();
    expect(deleteButton(box).disabled).toBe(false);
  });

  it("says why the server turned deleting down, and keeps the dialog", async () => {
    const server = new FakeServer();
    server.removed[PERSONAL] = [removedMade(LEDGER, 2)];
    start(server);
    fireEvent.click(within(await removedList("Personal")).getByRole("button", { name: "Delete permanently: Ledger" }));
    const box = await dialog("Delete Ledger for good?");
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "Ledger" } });

    server.fail = { ending: `/apps/m-ledger/data`, with: { status: 400, code: "invalid_request" } };
    fireEvent.click(deleteButton(box));
    expect(await within(box).findByText("The name typed is not the app's name. Type it as shown.")).toBeTruthy();
    server.fail = { ending: `/apps/m-ledger/data`, with: { status: 403, code: "forbidden" } };
    fireEvent.click(deleteButton(box));
    expect(await within(box).findByText("Only an owner of this space can delete an app.")).toBeTruthy();
    server.fail = { ending: `/apps/m-ledger/data`, with: { status: 500, code: "internal" } };
    fireEvent.click(deleteButton(box));
    expect(await within(box).findByText("The app could not be deleted. Try again.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delete Ledger for good?" })).toBeTruthy();
  });

  it("speaks Chinese", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { locale: "zh" });
    server.removed[FAMILY] = [removedFrom(FEED, 5)];
    start(server);

    const family = await spaceCard("Family");
    const list = await within(family).findByRole("list", { name: "已移除的应用" });
    expect(within(family).getByText("数据仍然保留")).toBeTruthy();
    expect(within(list).getByText("5 条数据")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "恢复Family的动态" }));
    const back = await dialog("恢复Family的动态？");
    expect(within(back).getByText("它会连同数据一起回来：5 条已保存的数据，以及它的设置。")).toBeTruthy();
    fireEvent.click(within(back).getByRole("button", { name: "取消" }));

    fireEvent.click(within(list).getByRole("button", { name: "永久删除Family的动态" }));
    const box = await dialog("要永久删除动态吗？");
    expect(within(box).getByText("它的 5 条数据、设置和所有版本都会被删除，Family里的所有人都将失去它。此操作无法撤销。")).toBeTruthy();
    expect(within(box).getByRole("textbox", { name: "输入“动态”以确认" })).toBeTruthy();
    expect(within(box).getByRole("button", { name: "删除" })).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "取消" }));

    fireEvent.click(within(family).getByRole("button", { name: "移除Family的清单" }));
    const remove = await dialog("移除Family的清单？");
    expect(within(remove).getByText(/在本页的“已移除的应用”里恢复它，或者再次添加它/)).toBeTruthy();
    expect(within(remove).getByRole("button", { name: "永久删除" })).toBeTruthy();
  });
});

describe("the hosts a built-in app fetches from", () => {
  /** The choice of one app in the dialog that adds apps: its radio button with everything written beside it. */
  const choice = (add: HTMLElement, name: RegExp) => within(add).getByRole("radio", { name }).closest("label") as HTMLElement;
  /** The texts under an app's name in its choice, in order. */
  const linesOf = (option: HTMLElement) =>
    Array.from(option.querySelectorAll("span > span"), (line) => line.textContent ?? "").filter((line) => line !== "");

  it("are named under the description of a new app, and nothing is said of an app that names none", async () => {
    const server = new FakeServer();
    server.catalog = WITH_HEADLINES;
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    expect(linesOf(choice(add, /Headlines/))).toEqual([
      "Headlines",
      "The latest headlines from two feeds.",
      "Fetches data from feeds.example.com, photos.example.net on its own.",
    ]);
    for (const other of [/Checklist/, /Feed/, /Counter/]) {
      expect(choice(add, other).textContent, String(other)).not.toMatch(/Fetches data/);
    }

    // The dialog asks nothing more: the app is added as any other.
    fireEvent.click(within(add).getByRole("radio", { name: /Headlines/ }));
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${PERSONAL}/catalog/headlines {}`]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("are named for an app brought back, before what comes back with it", async () => {
    const server = new FakeServer();
    server.catalog = WITH_HEADLINES;
    server.removed[FAMILY] = [removedFrom(HEADLINES, 4)];
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to Family");
    expect(await within(add).findByText("Removed earlier: adding it again brings back its data, 4 saved entries.")).toBeTruthy();
    expect(linesOf(choice(add, /Headlines/))).toEqual([
      "Headlines",
      "The latest headlines from two feeds.",
      "Fetches data from feeds.example.com, photos.example.net on its own.",
      "Removed earlier: adding it again brings back its data, 4 saved entries.",
    ]);
    fireEvent.click(within(add).getByRole("radio", { name: /Headlines/ }));
    fireEvent.click(within(add).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/catalog/headlines {"memberAccess":"none"}`]));
  });

  it("are named in Chinese, for a new app and for one brought back", async () => {
    const server = new FakeServer();
    server.catalog = WITH_HEADLINES;
    server.session = sessionWith([], { locale: "zh" });
    server.removed[FAMILY] = [removedFrom(HEADLINES, 4)];
    start(server);

    fireEvent.click(within(await spaceCard("个人")).getByRole("button", { name: "添加应用" }));
    const personal = await dialog("向个人空间添加应用");
    expect(linesOf(choice(personal, /头条/))).toEqual(["头条", "两个来源的最新头条。", "会自行从 feeds.example.com、photos.example.net 获取数据。"]);
    fireEvent.click(within(personal).getByRole("button", { name: "取消" }));

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "添加应用" }));
    const family = await dialog("向Family添加应用");
    expect(await within(family).findByText("曾被移除：再次添加会恢复它的数据，共 4 条。")).toBeTruthy();
    expect(linesOf(choice(family, /头条/))).toEqual([
      "头条",
      "两个来源的最新头条。",
      "会自行从 feeds.example.com、photos.example.net 获取数据。",
      "曾被移除：再次添加会恢复它的数据，共 4 条。",
    ]);
  });
});

describe("moving an app to another space", () => {
  it("moves a group's app to the owner's own space, after saying what goes along and who loses it", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY, { pinned: true })]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Move Checklist in Family" }));
    const move = await dialog("Move Checklist in Family to another space");
    // The personal space is the one place it can go, chosen already; nobody else is asked about there.
    const where = within(move).getByRole("group", { name: "Move to" });
    expect(within(where).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([PERSONAL]);
    expect((within(where).getByRole("radio", { name: /Personal/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(move).queryByRole("group", { name: "Who else can use it" })).toBeNull();
    expect(within(move).getByText(/Everything in it goes along/)).toBeTruthy();
    expect(within(move).getByText(/Anyone here who is not in that space loses it/)).toBeTruthy();

    fireEvent.click(within(move).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/apps/m-checklist/move {"toSpaceId":"${PERSONAL}"}`]));
    // It is in the personal space now, which says so and has the focus the dialog had.
    const personal = await spaceCard("Personal");
    const notice = await within(personal).findByText("Checklist was moved here.");
    expect(within(personal).getByRole("button", { name: "Pin Checklist" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(await spaceCard("Family")).getByText("No apps in this space yet.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(notice));
    // The family no longer has it, so it could go back there.
    fireEvent.click(within(personal).getByRole("button", { name: "Move Checklist" }));
    const back = await dialog("Move Checklist to another space");
    expect(within(back).getAllByRole("radio", { name: /Family/ })).toHaveLength(1);
    expect(within(back).queryByText(/loses it/)).toBeNull();
  });

  it("moves a personal app into a group, asking who else may use it there, only me for now first", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL)]);
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Move Feed" }));
    const move = await dialog("Move Feed to another space");
    expect((within(move).getByRole("radio", { name: /Family/ }) as HTMLInputElement).checked).toBe(true);
    const who = within(move).getByRole("group", { name: "Who else can use it" });
    expect((within(who).getByRole("radio", { name: "Only me for now" }) as HTMLInputElement).checked).toBe(true);
    // From a personal space nobody else had it, so nobody is said to lose it.
    expect(within(move).queryByText(/loses it/)).toBeNull();
    fireEvent.click(within(who).getByRole("radio", { name: "Everyone can view" }));
    fireEvent.click(within(move).getByRole("button", { name: "Move" }));

    await waitFor(() =>
      expect(server.changes).toEqual([`POST /api/spaces/${PERSONAL}/apps/m-feed/move {"toSpaceId":"${FAMILY}","memberAccess":"view"}`]),
    );
    expect(await within(await spaceCard("Family")).findByRole("switch", { name: "Show Feed in Family" })).toBeTruthy();
    expect(within(await spaceCard("Family")).getByText("Feed was moved here.")).toBeTruthy();
  });

  it("is offered to an owner of the space, towards the spaces where the person may add apps", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL), made(CHECKLIST, FAMILY)], { familyRole: "member", canAdd: true });
    start(server);

    // The feed may go to the family, where Sam may add apps.
    expect(within(await spaceCard("Personal")).getByRole("button", { name: "Move Feed" })).toBeTruthy();
    // A member does not move the group's apps, not even one who may add apps there.
    expect(within(await spaceCard("Family")).queryByRole("button", { name: /^Move/ })).toBeNull();

    // A member who may not add apps to the group cannot move anything into it.
    cleanup();
    server.session = sessionWith([made(FEED, PERSONAL)], { familyRole: "member", canAdd: false });
    start(server);
    expect(within(await spaceCard("Personal")).getByRole("button", { name: "Pin Feed" })).toBeTruthy();
    expect(within(await spaceCard("Personal")).queryByRole("button", { name: "Move Feed" })).toBeNull();
  });

  it("says when the app cannot be moved there, keeps the dialog open and reads the session again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL)]);
    server.fail = { ending: `POST /api/spaces/${PERSONAL}/apps/m-feed/move`, with: { status: 409, code: "conflict" } };
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Move Feed" }));
    const move = await dialog("Move Feed to another space");
    const sessions = server.count("GET /api/session");
    fireEvent.click(within(move).getByRole("button", { name: "Move" }));
    expect(
      await within(move).findByText("The app cannot be moved there. That space may have it already, or have kept its data from before."),
    ).toBeTruthy();
    expect(server.count("GET /api/session")).toBe(sessions + 1);
    expect(screen.getByRole("dialog", { name: "Move Feed to another space" })).toBeTruthy();

    // Anything else is worth another try.
    server.fail = { ending: `POST /api/spaces/${PERSONAL}/apps/m-feed/move`, with: { status: 500, code: "internal" } };
    fireEvent.click(within(move).getByRole("button", { name: "Move" }));
    expect(await within(move).findByText("The app could not be moved. Try again.")).toBeTruthy();
    fireEvent.click(within(move).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(await spaceCard("Personal")).getByRole("switch", { name: "Show Feed" })).toBeTruthy();
  });

  it("keeps a copy nobody changed out of groups, and says why and what to do instead", async () => {
    const server = new FakeServer();
    // The family is the one other space here, so a group is all this copy could be moved to.
    server.session = sessionWith([made(FEED, PERSONAL, { source: { listingId: "p-ledger0001", by: "Lin", untouched: true } })]);
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Move Feed" }));
    const move = await dialog("Move Feed to another space");
    const family = within(move).getByRole("radio", { name: /Family/ }) as HTMLInputElement;
    expect(family.disabled).toBe(true);
    expect(family.checked).toBe(false);
    expect(within(move).getByText("Not for a copy nobody changed")).toBeTruthy();
    expect(within(move).getByText(/A copy nobody changed stays where it was shared/)).toBeTruthy();
    expect(within(move).getByRole("link", { name: "the app center" }).getAttribute("href")).toBe("/center");
    expect(within(move).queryByRole("group", { name: "Who else can use it" })).toBeNull();
    expect((within(move).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(move).getByRole("button", { name: "Move" }));
    expect(server.changes).toEqual([]);
    fireEvent.click(within(move).getByRole("button", { name: "Cancel" }));

    // Changed, it is the person's own, and goes into a group like any app they made.
    cleanup();
    server.session = sessionWith([made(FEED, PERSONAL, { source: { listingId: "p-ledger0001", by: "Lin" } })]);
    start(server);
    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Move Feed" }));
    const changed = await dialog("Move Feed to another space");
    expect((within(changed).getByRole("radio", { name: /Family/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(changed).queryByText(/A copy nobody changed/)).toBeNull();
  });

  it("says in Chinese why a copy nobody changed stays out of groups", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL, { source: { untouched: true } })], { locale: "zh" });
    start(server);

    fireEvent.click(within(await spaceCard("个人")).getByRole("button", { name: /^移动/ }));
    const move = await screen.findByRole("dialog");
    expect((within(move).getByRole("radio", { name: /Family/ }) as HTMLInputElement).disabled).toBe(true);
    expect(within(move).getByText("未改动的副本不能移入")).toBeTruthy();
    expect(within(move).getByText(/没人改动过的副本留在它被分享到的地方/)).toBeTruthy();
    expect(within(move).getByRole("link", { name: "应用中心" }).getAttribute("href")).toBe("/center");
  });

  it("speaks Chinese", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { locale: "zh" });
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "移动Family的清单" }));
    const move = await dialog("把Family的清单移到另一个空间");
    expect((within(within(move).getByRole("group", { name: "移到" })).getByRole("radio", { name: /个人/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(move).getByText(/它的一切都会一起移过去/)).toBeTruthy();
    fireEvent.click(within(move).getByRole("button", { name: "移动" }));
    expect(await within(await spaceCard("个人")).findByText("清单已移到这里。")).toBeTruthy();
  });
});

describe("the settings dialog", () => {
  /** Where an app's page is drawn, in its sandbox. */
  const frameOf = (appId: string) => document.querySelector<HTMLIFrameElement>(`iframe[data-made-app="${appId}"]`);

  it("is drawn from what the app declares in two groups, saves only what was changed, and tells the app's page", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)]);
    start(server, `/apps/${FAMILY}/m-checklist`);

    await waitFor(() => expect(frameOf("m-checklist")).not.toBeNull());
    const told = vi.spyOn(frameOf("m-checklist")!.contentWindow!, "postMessage");
    fireEvent.click(await screen.findByRole("button", { name: "Settings of Checklist in Family" }));
    const settings = await dialog("Checklist settings");
    const everyone = await within(settings).findByRole("group", { name: "For everyone in this space" });
    const mine = within(settings).getByRole("group", { name: "Only for you" });
    expect(within(everyone).getByRole("group", { name: "Sections" })).toBeTruthy();
    expect(within(everyone).getByText("Items are grouped in this order.")).toBeTruthy();
    const hide = within(mine).getByRole("switch", { name: "Hide ticked items" });

    const save = within(settings).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(hide);
    expect(save.disabled).toBe(false);
    expect(told).not.toHaveBeenCalled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(server.changes).toEqual([`PATCH /api/spaces/${FAMILY}/apps/m-checklist/settings {"user":{"hideDone":true}}`]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The app's page reads its settings itself, and is told to read them again.
    expect(told).toHaveBeenCalledWith({ type: "hearth:changed" }, "*");
  });

  it("edits a list: adds, moves and removes entries", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, PERSONAL)]);
    server.settings["m-checklist"] = { space: { sections: ["Garden", "House"] }, user: { hideDone: false } };
    start(server, "/");

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Checklist" }));
    const settings = await dialog("Checklist settings");
    const sections = await within(settings).findByRole("group", { name: "Sections" });
    expect(within(settings).getByRole("group", { name: "For this space" })).toBeTruthy();

    const fresh = within(sections).getByRole("textbox", { name: "New entry in Sections" });
    fireEvent.change(fresh, { target: { value: "  Errands " } });
    fireEvent.keyDown(fresh, { key: "Enter" });
    fireEvent.click(within(sections).getByRole("button", { name: "Move entry 2 down" }));
    fireEvent.click(within(sections).getByRole("button", { name: "Remove entry 1" }));
    fireEvent.change(within(sections).getByRole("textbox", { name: "Entry 2 in Sections" }), { target: { value: "Home" } });
    expect(server.changes).toEqual([]);

    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.changes).toEqual([
        `PATCH /api/spaces/${PERSONAL}/apps/m-checklist/settings {"space":{"sections":["Errands","Home"]}}`,
      ]),
    );
  });

  it("chooses options of a select and a multi-select, in the order of the options", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(FEED, PERSONAL)]);
    start(server, "/");

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Feed" }));
    const settings = await dialog("Feed settings");
    const topics = await within(settings).findByRole("group", { name: "Topics" });
    fireEvent.click(within(topics).getByRole("button", { name: "Food" }));
    fireEvent.click(within(topics).getByRole("button", { name: "Science" }));
    fireEvent.click(within(within(settings).getByRole("group", { name: "Period" })).getByRole("button", { name: "This week" }));
    // An app with nothing for the whole space has one group only.
    expect(within(settings).queryByRole("group", { name: "For this space" })).toBeNull();

    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.changes).toEqual([
        `PATCH /api/spaces/${PERSONAL}/apps/m-feed/settings {"user":{"topics":["science","food"],"period":"week"}}`,
      ]),
    );
    // Opened again, it shows what was saved.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Settings of Feed" }));
    const again = await within(await dialog("Feed settings")).findByRole("group", { name: "Topics" });
    expect(within(again).getAllByRole("button").filter((chip) => pressed(chip)).map((chip) => chip.textContent)).toEqual(["Science", "Food"]);
  });

  it("checks a number against its limits before sending it, and edits text", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(COUNTER, PERSONAL)]);
    start(server);

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Counter" }));
    const settings = await dialog("Counter settings");
    const goal = (await within(settings).findByRole("spinbutton", { name: "Daily goal" })) as HTMLInputElement;
    expect(goal.value).toBe("5");
    expect(within(settings).getByText("How many a day. From 1 to 10. In steps of 1.")).toBeTruthy();
    const save = within(settings).getByRole("button", { name: "Save" }) as HTMLButtonElement;

    for (const [typed, problem] of [
      ["11", "This number does not fit."],
      ["2.5", "This number does not fit."],
      ["", "Enter a number."],
    ] as const) {
      fireEvent.change(goal, { target: { value: typed } });
      expect(within(settings).getByText(problem)).toBeTruthy();
      expect(goal.getAttribute("aria-invalid")).toBe("true");
      expect(save.disabled).toBe(true);
    }
    fireEvent.change(goal, { target: { value: "8" } });
    expect(goal.getAttribute("aria-invalid")).toBeNull();
    const title = within(settings).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(title.maxLength).toBe(20);
    fireEvent.change(title, { target: { value: "Glasses of water" } });

    fireEvent.click(save);
    await waitFor(() =>
      expect(server.changes).toEqual([
        `PATCH /api/spaces/${PERSONAL}/apps/m-counter/settings {"space":{"title":"Glasses of water"},"user":{"goal":8}}`,
      ]),
    );
  });

  it("shows the space's settings to someone who may only view, and lets them change only their own", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(COUNTER, FAMILY, { access: "view" })], { familyRole: "member" });
    start(server);

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Counter in Family" }));
    const settings = await dialog("Counter settings");
    const everyone = await within(settings).findByRole("group", { name: "For everyone in this space" });
    expect(within(everyone).getByText("You may only view this app, so you cannot change these.")).toBeTruthy();
    expect((within(everyone).getByRole("textbox", { name: "Title" }) as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);

    fireEvent.change(within(settings).getByRole("spinbutton", { name: "Daily goal" }), { target: { value: "3" } });
    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.changes).toEqual([`PATCH /api/spaces/${FAMILY}/apps/m-counter/settings {"user":{"goal":3}}`]),
    );
  });

  it("stays open and says so when the server turns the change down", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(COUNTER, PERSONAL)]);
    server.fail = { ending: "/m-counter/settings", with: { status: 403, code: "forbidden" } };
    start(server);

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Counter" }));
    const settings = await dialog("Counter settings");
    // Even the settings could not be read: the dialog says so and offers to try again.
    expect(await within(settings).findByText("The settings could not be loaded.")).toBeTruthy();
    server.fail = { ending: `PATCH /api/spaces/${PERSONAL}/apps/m-counter/settings`, with: { status: 403, code: "forbidden" } };
    fireEvent.click(within(settings).getByRole("button", { name: "Try again" }));

    fireEvent.change(await within(settings).findByRole("textbox", { name: "Title" }), { target: { value: "Ours" } });
    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));
    expect(await within(settings).findByText(/The settings were not saved/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Counter settings" })).toBeTruthy();
  });

  it("reads the session again when the server says the app is not there, and the app goes with its dialog", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(COUNTER, PERSONAL), made(FEED, PERSONAL)]);
    start(server);

    fireEvent.click(await within(await spaceCard("Personal")).findByRole("button", { name: "Settings of Counter" }));
    const settings = await dialog("Counter settings");
    fireEvent.change(await within(settings).findByRole("textbox", { name: "Title" }), { target: { value: "Ours" } });
    // Meanwhile an owner removed it.
    server.session = sessionWith([made(FEED, PERSONAL)]);
    const sessions = server.count("GET /api/session");
    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("GET /api/session")).toBe(sessions + 1);
    const personal = await spaceCard("Personal");
    expect(within(personal).queryByRole("switch", { name: "Show Counter" })).toBeNull();
    expect(within(personal).getByRole("switch", { name: "Show Feed" })).toBeTruthy();
  });

  it("does the same when it is reading the settings that finds the app gone", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(COUNTER, PERSONAL)]);
    start(server);

    const open = await within(await spaceCard("Personal")).findByRole("button", { name: "Settings of Counter" });
    server.session = sessionWith([]);
    fireEvent.click(open);
    await waitFor(() => expect(within(main()).queryByRole("switch", { name: "Show Counter" })).toBeNull());
    expect(server.count("GET /api/session")).toBe(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is not offered for an app that declares no settings", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(HEADLINES, PERSONAL), made(COUNTER, PERSONAL)]);
    start(server);

    expect(await within(await spaceCard("Personal")).findByRole("button", { name: "Settings of Counter" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settings of Headlines" })).toBeNull();
  });

  it("speaks Chinese, the app's labels included", async () => {
    const server = new FakeServer();
    server.session = sessionWith([made(CHECKLIST, FAMILY)], { locale: "zh" });
    start(server, `/apps/${FAMILY}/m-checklist`);

    fireEvent.click(await screen.findByRole("button", { name: "Family的清单的设置" }));
    const settings = await dialog("清单设置");
    expect(await within(settings).findByRole("group", { name: "对这个空间的所有人" })).toBeTruthy();
    expect(within(settings).getByRole("group", { name: "仅对你自己" })).toBeTruthy();
    expect(within(settings).getByRole("switch", { name: "隐藏已勾选的事项" })).toBeTruthy();
    expect(within(settings).getByText("事项按此顺序分组。")).toBeTruthy();
    expect(within(settings).getByRole("button", { name: "保存" })).toBeTruthy();
  });

  it("opens on what the server holds now, not on what an earlier opening read", async () => {
    const server = new FakeServer();
    const settings = { shown: { type: "switch", scope: "user", default: false, label: { en: "Show done", zh: "显示已完成" } } };
    server.session = sessionWith([made(HEADLINES, PERSONAL, { id: "m-aaaaaaaaaa", name: { en: "Notes", zh: "Notes" }, settings })]);
    server.settings["m-aaaaaaaaaa"] = { space: {}, user: { shown: false } };
    start(server, "/");

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Notes" }));
    const before = await dialog("Notes settings");
    expect((await within(before).findByRole("switch", { name: "Show done" })).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(before).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Meanwhile the app's page changed it through the bridge, which this cache never sees.
    server.settings["m-aaaaaaaaaa"] = { space: {}, user: { shown: true } };
    fireEvent.click(screen.getByRole("button", { name: "Settings of Notes" }));
    const after = await dialog("Notes settings");
    await waitFor(() => expect(within(after).getByRole("switch", { name: "Show done" }).getAttribute("aria-checked")).toBe("true"));
  });
});

describe("an app's page", () => {
  const frameOf = (appId: string) => document.querySelector(`iframe[data-made-app="${appId}"]`);

  it("gets a frame of its own on each app's page, so that the page shown before is never answered as the next app", async () => {
    const server = new FakeServer();
    server.session = sessionWith([
      made(HEADLINES, PERSONAL, { id: "m-aaaaaaaaaa", name: { en: "Notes", zh: "Notes" } }),
      made(HEADLINES, PERSONAL, { id: "m-bbbbbbbbbb", name: { en: "Ledger", zh: "Ledger" } }),
    ]);
    start(server, `/apps/${PERSONAL}/m-aaaaaaaaaa`);
    await waitFor(() => expect(frameOf("m-aaaaaaaaaa")).not.toBeNull());
    const first = frameOf("m-aaaaaaaaaa")!;

    // To the other app's page from the sidebar, without leaving the web app.
    fireEvent.click(screen.getAllByRole("link", { name: "Ledger" })[0]!);
    await waitFor(() => expect(frameOf("m-bbbbbbbbbb")).not.toBeNull());
    expect(frameOf("m-bbbbbbbbbb")).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });
});
