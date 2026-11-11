/**
 * The Apps page and the settings dialog: adding an app to a space,
 * removing it, each person's own switch and pin, and the settings form the
 * shell draws from an app's manifest. The whole web app is drawn with the
 * framework's sample apps (packages/fixture-apps), one test app with the
 * setting types the samples do not use, and a stand-in for the server.
 */
import { defineApp, type Manifest } from "@hearth/sdk";
import type { AppSettings, AppSummary, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import checklistManifest from "../../../fixture-apps/checklist/manifest";
import feedManifest from "../../../fixture-apps/feed/manifest";
import { App } from "../app";
import { BundledAppsProvider, type BundledApp, type LazyComponent } from "./bundled";

const PERSONAL = "space-personal";
const FAMILY = "space-family";

const parts = import.meta.glob<{ default: ComponentType }>("../../../fixture-apps/*/{widget,page}.tsx");
function part(file: string): LazyComponent {
  const load = parts[`../../../fixture-apps/${file}.tsx`];
  if (!load) throw new Error(`packages/fixture-apps has no ${file}.tsx`);
  return load;
}

/** An app with the two setting types the sample apps do not have: text and a number. */
const counter = defineApp({
  id: "counter",
  name: { en: "Counter", zh: "计数器" },
  description: { en: "Counts things for you.", zh: "帮你数东西。" },
  icon: "clock",
  color: "amber",
  widget: { size: "small" },
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
});

const Empty = () => null;
const BUNDLED: readonly BundledApp[] = [
  { id: "checklist", manifest: checklistManifest, hasPage: true, widget: part("checklist/widget"), page: part("checklist/page") },
  { id: "feed", manifest: feedManifest, hasPage: false, widget: part("feed/widget") },
  { id: "counter", manifest: counter, hasPage: false, widget: () => Promise.resolve({ default: Empty }) },
];
const MANIFESTS: Record<string, Manifest> = { checklist: checklistManifest, feed: feedManifest, counter };

function summary(manifest: Manifest, spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id: manifest.id,
    spaceId,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    color: manifest.color,
    widgetSize: manifest.widget.size,
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: BUNDLED.find((app) => app.id === manifest.id)?.hasPage ?? false,
    ...extra,
  };
}

function sessionWith(apps: AppSummary[], options: { locale?: "en" | "zh"; familyRole?: "owner" | "member"; canAdd?: boolean } = {}): Session {
  const me = { id: "u1", email: "sam@example.com", name: "Sam Example", locale: options.locale ?? "en", theme: "light" as const };
  const role = options.familyRole ?? "owner";
  return {
    user: me,
    spaces: [
      { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, members: [{ id: me.id, name: me.name, role: "owner" }] },
      {
        id: FAMILY,
        kind: "group",
        name: "Family",
        role,
        canAddApps: options.canAdd ?? role === "owner",
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

/** Stands in for the server: the session, adding and removing apps, switches and pins, settings. */
class FakeServer {
  session: Session = sessionWith([]);
  settings: Record<string, AppSettings> = {
    checklist: { space: { sections: [] }, user: { hideDone: false } },
    feed: { space: {}, user: { topics: [], period: "day" } },
    counter: { space: { title: "Things" }, user: { goal: 5 } },
  };
  /** Answer requests whose "METHOD path" ends like this with a failure, until cleared. */
  fail: { ending: string; with: Failure } | null = null;
  /** Every request that changes something, as "METHOD path body". */
  readonly changes: string[] = [];
  readonly requests: string[] = [];

  count(ending: string): number {
    return this.requests.filter((request) => request.endsWith(ending)).length;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${path}`);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET" && !path.includes("/q/")) this.changes.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    const json = (status: number, value: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (this.fail && `${method} ${path}`.endsWith(this.fail.ending)) {
      return json(this.fail.with.status, { error: { code: this.fail.with.code, message: "Sample failure" } });
    }
    if (path === "/api/session") return json(200, this.session);

    const match = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)(?:\/(.+))?$/.exec(path);
    const [, spaceId = "", appId = "", rest = ""] = match ?? [];
    const listed = this.session.apps.find((app) => app.spaceId === spaceId && app.id === appId);
    if (match && rest === "" && method === "PUT") {
      const manifest = MANIFESTS[appId];
      if (!manifest) return json(404, { error: { code: "not_found", message: "No such app." } });
      if (!listed) this.session = { ...this.session, apps: [...this.session.apps, summary(manifest, spaceId)] };
      return json(204, null);
    }
    if (!listed) return json(404, { error: { code: "not_found", message: "No such app." } });
    if (rest === "" && method === "DELETE") {
      this.session = { ...this.session, apps: this.session.apps.filter((app) => app !== listed) };
      return json(204, null);
    }
    if (rest === "move" && method === "POST") {
      const { toSpaceId } = body as { toSpaceId: string };
      if (this.session.apps.some((app) => app.spaceId === toSpaceId && app.id === appId)) {
        return json(409, { error: { code: "conflict", message: "That space has the app." } });
      }
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
    if (rest === "q/list") return json(200, { output: [] });
    return json(404, { error: { code: "not_found", message: "No such route." } });
  };
}

function start(server: FakeServer, at = "/apps", bundled: readonly BundledApp[] = BUNDLED) {
  vi.stubGlobal("fetch", server.fetch);
  render(
    <MemoryRouter initialEntries={[at]}>
      <BundledAppsProvider apps={bundled}>
        <App queryClient={new QueryClient()} />
      </BundledAppsProvider>
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Apps page", () => {
  it("lists every app by space, switched-off ones included, with the person's own controls", async () => {
    const server = new FakeServer();
    server.session = sessionWith([
      summary(checklistManifest, PERSONAL),
      summary(feedManifest, PERSONAL, { enabled: false }),
      summary(checklistManifest, FAMILY, { access: "view", pinned: true }),
    ]);
    start(server);

    const personal = await spaceCard("Personal");
    expect(within(personal).getByRole("switch", { name: "Show Checklist" }).getAttribute("aria-checked")).toBe("true");
    expect(within(personal).getByRole("switch", { name: "Show Feed" }).getAttribute("aria-checked")).toBe("false");
    expect(within(personal).getByText(/Switched off/)).toBeTruthy();
    // A switched-off app has no link to its page; one that is on does.
    expect(within(personal).getByRole("link", { name: "Checklist" }).getAttribute("href")).toBe(`/apps/${PERSONAL}/checklist`);

    const family = await spaceCard("Family");
    expect(within(family).getByText("View only")).toBeTruthy();
    expect(pressed(within(family).getByRole("button", { name: "Pin Checklist in Family" }))).toBe(true);
    // The pinned one is a shortcut at the top too.
    const pinned = within(main()).getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("link", { name: "Checklist in Family" })).toBeTruthy();
  });

  it("switches an app off for this person, which takes it off the dashboard, and on again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, PERSONAL), summary(feedManifest, PERSONAL)]);
    start(server);

    const personal = await spaceCard("Personal");
    const show = within(personal).getByRole("switch", { name: "Show Feed" });
    fireEvent.click(show);
    // Saved by the server, and the session read again.
    await waitFor(() => expect(switchedOn(show)).toBe(false));
    await waitFor(() => expect(server.changes).toEqual([`PATCH /api/spaces/${PERSONAL}/apps/feed/me {"enabled":false}`]));
    await waitFor(() => expect(server.count("GET /api/session")).toBe(2));

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    const grid = await screen.findByTestId("widget-grid");
    expect(within(grid).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Checklist"]);

    fireEvent.click(screen.getAllByRole("link", { name: "Apps" })[0] as HTMLElement);
    fireEvent.click(within(await spaceCard("Personal")).getByRole("switch", { name: "Show Feed" }));
    await waitFor(() => expect(server.changes).toHaveLength(2));
    expect(server.changes[1]).toBe(`PATCH /api/spaces/${PERSONAL}/apps/feed/me {"enabled":true}`);
  });

  it("pins an app: it joins the shortcuts and comes first on the dashboard", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(feedManifest, PERSONAL), summary(checklistManifest, PERSONAL)]);
    start(server);

    const personal = await spaceCard("Personal");
    expect(within(main()).getByText("Nothing pinned yet.")).toBeTruthy();
    fireEvent.click(within(personal).getByRole("button", { name: "Pin Checklist" }));
    await waitFor(() => expect(server.changes).toEqual([`PATCH /api/spaces/${PERSONAL}/apps/checklist/me {"pinned":true}`]));
    const pinned = within(main()).getByRole("region", { name: "Pinned" });
    expect(await within(pinned).findByRole("link", { name: "Checklist" })).toBeTruthy();
    // Pinned apps are listed first in their space as well.
    const rows = within(await spaceCard("Personal")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-app-row"))).toEqual(["checklist", "feed"]);

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    const grid = await screen.findByTestId("widget-grid");
    expect(within(grid).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Checklist", "Feed"]);
  });

  it("puts the switch back and says so when the server does not save it", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
    server.fail = { ending: "/feed/me", with: { status: 500, code: "internal" } };
    start(server);

    const personal = await spaceCard("Personal");
    fireEvent.click(within(personal).getByRole("switch", { name: "Show Feed" }));
    expect(await within(personal).findByText("That change could not be saved. Try again.")).toBeTruthy();
    await waitFor(() => expect(switchedOn(within(personal).getByRole("switch", { name: "Show Feed" }))).toBe(true));
  });

  it("adds an app this build holds to the personal space, without asking about anyone else", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, PERSONAL)]);
    start(server);

    fireEvent.click(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to your personal space");
    // The checklist is there already; the others are offered, the first one chosen.
    expect(within(add).getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["feed", "counter"]);
    expect(within(add).queryByRole("group", { name: "Who else can use it" })).toBeNull();
    fireEvent.click(within(add).getByRole("radio", { name: /Counter/ }));
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(server.changes).toEqual([`PUT /api/spaces/${PERSONAL}/apps/counter {}`]));
    expect(await within(await spaceCard("Personal")).findByRole("switch", { name: "Show Counter" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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
    await waitFor(() => expect(server.changes).toEqual([`PUT /api/spaces/${FAMILY}/apps/checklist {"memberAccess":"edit"}`]));
  });

  it("says when an app cannot be added, and keeps the dialog open", async () => {
    const server = new FakeServer();
    server.session = sessionWith([], { familyRole: "member", canAdd: true });
    server.fail = { ending: `PUT /api/spaces/${FAMILY}/apps/checklist`, with: { status: 409, code: "conflict" } };
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Add an app" }));
    const add = await dialog("Add an app to Family");
    fireEvent.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByText("This app cannot be added here. Ask an owner of the space.")).toBeTruthy();
  });

  it("offers adding only where the person may, and removing only to an owner", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY, { access: "edit" })], { familyRole: "member" });
    start(server);

    const family = await spaceCard("Family");
    expect(within(family).queryByRole("button", { name: "Add an app" })).toBeNull();
    expect(within(family).queryByRole("button", { name: /Remove/ })).toBeNull();
    // Pin and switch are everyone's own.
    expect(within(family).getByRole("button", { name: "Pin Checklist in Family" })).toBeTruthy();
    expect(within(await spaceCard("Personal")).getByRole("button", { name: "Add an app" })).toBeTruthy();
  });

  it("removes an app from a space after asking, and says that its data is kept", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY)]);
    start(server);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Checklist in Family" }));
    const remove = await dialog("Remove Checklist in Family?");
    expect(within(remove).getByText(/Its data is kept/)).toBeTruthy();
    fireEvent.click(within(remove).getByRole("button", { name: "Cancel" }));
    expect(server.changes).toEqual([]);

    fireEvent.click(within(await spaceCard("Family")).getByRole("button", { name: "Remove Checklist in Family" }));
    fireEvent.click(within(await dialog("Remove Checklist in Family?")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.changes).toEqual([`DELETE /api/spaces/${FAMILY}/apps/checklist null`]));
    expect(await within(await spaceCard("Family")).findByText("No apps in this space yet.")).toBeTruthy();
  });

  it("speaks Chinese", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY)], { locale: "zh" });
    start(server);
    const family = await spaceCard("Family");
    expect(within(family).getByRole("switch", { name: "显示Family的清单" })).toBeTruthy();
    fireEvent.click(within(family).getByRole("button", { name: "添加应用" }));
    const add = await dialog("向Family添加应用");
    expect(within(add).getByRole("radio", { name: "暂时只有我" })).toBeTruthy();
  });
});

describe("moving an app to another space", () => {
  it("moves a group's app to the owner's own space, after saying what goes along and who loses it", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY, { pinned: true })]);
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
    await waitFor(() => expect(server.changes).toEqual([`POST /api/spaces/${FAMILY}/apps/checklist/move {"toSpaceId":"${PERSONAL}"}`]));
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
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
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
      expect(server.changes).toEqual([`POST /api/spaces/${PERSONAL}/apps/feed/move {"toSpaceId":"${FAMILY}","memberAccess":"view"}`]),
    );
    expect(await within(await spaceCard("Family")).findByRole("switch", { name: "Show Feed in Family" })).toBeTruthy();
    expect(within(await spaceCard("Family")).getByText("Feed was moved here.")).toBeTruthy();
  });

  it("is offered to an owner of the space, towards spaces where the person may add apps, that lack the app and that its manifest allows", async () => {
    const journal = defineApp({
      id: "journal",
      name: { en: "Journal", zh: "日记" },
      description: { en: "One entry a day, for you alone.", zh: "每天一篇，只给自己看。" },
      icon: "notebook-text",
      color: "purple",
      spaces: ["personal"],
      widget: { size: "wide" },
    });
    const bundled = [...BUNDLED, { id: "journal", manifest: journal, hasPage: false, widget: () => Promise.resolve({ default: Empty }) }];
    const server = new FakeServer();
    server.session = sessionWith(
      [
        summary(checklistManifest, PERSONAL),
        summary(feedManifest, PERSONAL),
        summary(journal, PERSONAL),
        summary(checklistManifest, FAMILY),
        summary(counter, FAMILY),
      ],
      { familyRole: "member", canAdd: true },
    );
    start(server, "/apps", bundled);

    const personal = await spaceCard("Personal");
    // The feed may go to the family; the family has a checklist already; the journal is for personal spaces only.
    expect(within(personal).getByRole("button", { name: "Move Feed" })).toBeTruthy();
    expect(within(personal).queryByRole("button", { name: "Move Checklist" })).toBeNull();
    expect(within(personal).queryByRole("button", { name: "Move Journal" })).toBeNull();
    // A member does not move the group's apps, not even one who may add apps there.
    const family = await spaceCard("Family");
    expect(within(family).queryByRole("button", { name: /^Move/ })).toBeNull();

    // A member who may not add apps to the group cannot move anything into it.
    cleanup();
    server.session = sessionWith([summary(feedManifest, PERSONAL)], { familyRole: "member", canAdd: false });
    start(server, "/apps", bundled);
    expect(within(await spaceCard("Personal")).getByRole("button", { name: "Pin Feed" })).toBeTruthy();
    expect(within(await spaceCard("Personal")).queryByRole("button", { name: "Move Feed" })).toBeNull();
  });

  it("says when the app cannot be moved there, keeps the dialog open and reads the session again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
    server.fail = { ending: `POST /api/spaces/${PERSONAL}/apps/feed/move`, with: { status: 409, code: "conflict" } };
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
    server.fail = { ending: `POST /api/spaces/${PERSONAL}/apps/feed/move`, with: { status: 500, code: "internal" } };
    fireEvent.click(within(move).getByRole("button", { name: "Move" }));
    expect(await within(move).findByText("The app could not be moved. Try again.")).toBeTruthy();
    fireEvent.click(within(move).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(await spaceCard("Personal")).getByRole("switch", { name: "Show Feed" })).toBeTruthy();
  });

  it("speaks Chinese", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY)], { locale: "zh" });
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
  it("is drawn from the manifest in two groups, and saves only what was changed", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY)]);
    start(server, `/apps/${FAMILY}/checklist`);

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
    fireEvent.click(save);

    await waitFor(() =>
      expect(server.changes).toEqual([`PATCH /api/spaces/${FAMILY}/apps/checklist/settings {"user":{"hideDone":true}}`]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The app's own code reads its settings and queries again.
    await waitFor(() => expect(server.count(`POST /api/spaces/${FAMILY}/apps/checklist/q/list`)).toBe(2));
  });

  it("edits a list: adds, moves and removes entries", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, PERSONAL)]);
    server.settings.checklist = { space: { sections: ["Garden", "House"] }, user: { hideDone: false } };
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
        `PATCH /api/spaces/${PERSONAL}/apps/checklist/settings {"space":{"sections":["Errands","Home"]}}`,
      ]),
    );
  });

  it("chooses options of a select and a multi-select, in the order of the options", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
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
        `PATCH /api/spaces/${PERSONAL}/apps/feed/settings {"user":{"topics":["science","food"],"period":"week"}}`,
      ]),
    );
    // The card shows the new settings.
    expect(await screen.findByText("Following 2 topics")).toBeTruthy();
  });

  it("checks a number against its limits before sending it, and edits text", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(counter, PERSONAL)]);
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
        `PATCH /api/spaces/${PERSONAL}/apps/counter/settings {"space":{"title":"Glasses of water"},"user":{"goal":8}}`,
      ]),
    );
  });

  it("shows the space's settings to someone who may only view, and lets them change only their own", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(counter, FAMILY, { access: "view" })], { familyRole: "member" });
    start(server);

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Counter in Family" }));
    const settings = await dialog("Counter settings");
    const everyone = await within(settings).findByRole("group", { name: "For everyone in this space" });
    expect(within(everyone).getByText("You may only view this app, so you cannot change these.")).toBeTruthy();
    expect((within(everyone).getByRole("textbox", { name: "Title" }) as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);

    fireEvent.change(within(settings).getByRole("spinbutton", { name: "Daily goal" }), { target: { value: "3" } });
    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.changes).toEqual([`PATCH /api/spaces/${FAMILY}/apps/counter/settings {"user":{"goal":3}}`]),
    );
  });

  it("stays open and says so when the server turns the change down", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(counter, PERSONAL)]);
    server.fail = { ending: "/counter/settings", with: { status: 403, code: "forbidden" } };
    start(server);

    fireEvent.click(await screen.findByRole("button", { name: "Settings of Counter" }));
    const settings = await dialog("Counter settings");
    // Even the settings could not be read: the dialog says so and offers to try again.
    expect(await within(settings).findByText("The settings could not be loaded.")).toBeTruthy();
    server.fail = { ending: "PATCH /api/spaces/space-personal/apps/counter/settings", with: { status: 403, code: "forbidden" } };
    fireEvent.click(within(settings).getByRole("button", { name: "Try again" }));

    fireEvent.change(await within(settings).findByRole("textbox", { name: "Title" }), { target: { value: "Ours" } });
    fireEvent.click(within(settings).getByRole("button", { name: "Save" }));
    expect(await within(settings).findByText(/The settings were not saved/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Counter settings" })).toBeTruthy();
  });

  it("speaks Chinese, the app's labels included", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(checklistManifest, FAMILY)], { locale: "zh" });
    start(server, `/apps/${FAMILY}/checklist`);

    fireEvent.click(await screen.findByRole("button", { name: "Family的清单的设置" }));
    const settings = await dialog("清单设置");
    expect(await within(settings).findByRole("group", { name: "对这个空间的所有人" })).toBeTruthy();
    expect(within(settings).getByRole("group", { name: "仅对你自己" })).toBeTruthy();
    expect(within(settings).getByRole("switch", { name: "隐藏已勾选的事项" })).toBeTruthy();
    expect(within(settings).getByText("事项按此顺序分组。")).toBeTruthy();
    expect(within(settings).getByRole("button", { name: "保存" })).toBeTruthy();
  });
});
