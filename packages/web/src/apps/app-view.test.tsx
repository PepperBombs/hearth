/**
 * Widgets and pages in the shell: the whole web app, drawn with the
 * framework's own sample apps (packages/fixture-apps) and a stand-in for
 * the server that answers the session and the apps' routes from memory.
 */
import { defineApp, type Manifest } from "@hearth/sdk";
import { defineServer, z } from "@hearth/sdk/server";
import { appHooks } from "@hearth/sdk/web";
import type { AppSummary, JobStatus, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import checklistManifest from "../../../fixture-apps/checklist/manifest";
import feedManifest from "../../../fixture-apps/feed/manifest";
import { App } from "../app";
import { reloadPage } from "../lib/reload";
import { BundledAppsProvider, type BundledApp, type LazyComponent } from "./bundled";
import { REFRESH_EVERY_MS, RUNNING_REFRESH_MS, appTranslator } from "./scope";

vi.mock("../lib/reload", () => ({ reloadPage: vi.fn() }));

const PERSONAL = "space-personal";
const FAMILY = "space-family";

/**
 * The sample apps' widgets and pages, fetched when first drawn, as the build
 * hands them over. Found by pattern, so that the type check of the web app
 * does not walk into an app's code: that is checked with the apps' own
 * configuration (packages/fixture-apps/tsconfig.json).
 */
const parts = import.meta.glob<{ default: ComponentType }>("../../../fixture-apps/*/{widget,page}.tsx");
function part(file: string): LazyComponent {
  const load = parts[`../../../fixture-apps/${file}.tsx`];
  if (!load) throw new Error(`packages/fixture-apps has no ${file}.tsx`);
  return load;
}

const CHECKLIST: BundledApp = {
  id: "checklist",
  manifest: checklistManifest,
  hasPage: true,
  widget: part("checklist/widget"),
  page: part("checklist/page"),
};
const FEED: BundledApp = {
  id: "feed",
  manifest: feedManifest,
  hasPage: false,
  widget: part("feed/widget"),
};

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
    hasPage: false,
    ...extra,
  };
}

function sessionWith(apps: AppSummary[], user: Partial<Session["user"]> = {}): Session {
  const me = { id: "u1", email: "sam@example.com", name: "Sam Example", locale: "en" as const, theme: "light" as const, ...user };
  return {
    user: me,
    spaces: [
      { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, members: [{ id: me.id, name: me.name, role: "owner" }] },
      {
        id: FAMILY,
        kind: "group",
        name: "Family",
        role: "owner",
        canAddApps: true,
        members: [
          { id: me.id, name: me.name, role: "owner" },
          { id: "u2", name: "Lin Example", role: "member" },
        ],
      },
    ],
    apps,
    canCreateGroups: false,
    canInvitePeople: false,
    version: "test",
  };
}

type Item = { id: string; name: string; section: string; done: boolean };
const row = (item: Item) => ({ ...item, createdBy: "u1", updatedBy: "u1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

type Refusal = { status: number; code: string };

/** The status of a job that has not run yet, due at the start. */
const NOT_RUN: JobStatus = {
  lastStartedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  nextRunAt: "2026-03-01T13:05:00.000Z",
  state: "idle",
};

/** Stands in for the server. Tests change what it holds and how it answers between requests. */
class FakeServer {
  session: Session = sessionWith([]);
  /** What the session is once it has been answered the next time. */
  sessionAfterwards: Session | null = null;
  items: Item[] = [
    { id: "i1", name: "Water the plants", section: "", done: false },
    { id: "i2", name: "Book the dentist", section: "", done: false },
  ];
  settings: Record<string, { space: Record<string, unknown>; user: Record<string, unknown> }> = {
    checklist: { space: { sections: [] }, user: { hideDone: false } },
    feed: { space: {}, user: { topics: [], period: "day" } },
  };
  /** The headlines the ticker's query answers with, newest first. */
  headlines: string[] = ["Rain expected", "Market opens"];
  /** The status of the ticker's job, as the server would answer it. */
  job: JobStatus = NOT_RUN;
  /** Answer the next requests whose path ends like this with a refusal, until cleared. */
  refuse: { ending: string; with: Refusal } | null = null;
  /**
   * Hold back the answers to requests whose path ends like this until the
   * promise resolves, as a slow network would: the answer is what was true
   * when the request arrived.
   */
  hold: { ending: string; until: Promise<void> } | null = null;
  /** Every request, as "METHOD path". */
  readonly requests: string[] = [];
  readonly bodies: unknown[] = [];

  count(ending: string): number {
    return this.requests.filter((request) => request.endsWith(ending)).length;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = String(input);
    const hold = this.hold !== null && path.endsWith(this.hold.ending) ? this.hold.until : null;
    const response = this.answer(path, init);
    if (hold !== null) await hold;
    return response;
  };

  private answer(path: string, init: RequestInit): Response {
    const method = init.method ?? "GET";
    this.requests.push(`${method} ${path}`);
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (body !== undefined) this.bodies.push(body);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

    if (this.refuse && path.endsWith(this.refuse.ending)) {
      const { status, code } = this.refuse.with;
      return json(status, { error: { code, message: "Sample failure" } });
    }
    if (path === "/api/session") {
      const answer = json(200, this.session);
      if (this.sessionAfterwards) [this.session, this.sessionAfterwards] = [this.sessionAfterwards, null];
      return answer;
    }

    const match = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)\/(.+)$/.exec(path);
    const [, , appId = "", rest = ""] = match ?? [];
    const sent = (body as { input?: Record<string, unknown> } | undefined)?.input;
    if (rest === "settings" && method === "GET" && this.settings[appId]) return json(200, this.settings[appId]);
    if (appId === "checklist" && method === "POST") {
      if (rest === "q/list") return json(200, { output: this.items.map(row) });
      if (rest === "m/tick") {
        const item = this.items.find((candidate) => candidate.id === sent?.id);
        if (!item) return json(404, { error: { code: "not_found", message: "No such item." } });
        item.done = sent?.done === true;
        return json(200, { output: row(item) });
      }
      if (rest === "m/add") {
        const item = { id: `i${this.items.length + 1}`, name: String(sent?.name), section: String(sent?.section ?? ""), done: false };
        this.items.push(item);
        return json(200, { output: row(item) });
      }
      if (rest === "m/clearTicked") {
        const before = this.items.length;
        this.items = this.items.filter((item) => !item.done);
        return json(200, { output: before - this.items.length });
      }
    }
    if (appId === "ticker") {
      if (rest === "q/latest" && method === "POST") {
        const kept = { createdBy: "u1", updatedBy: "u1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
        return json(200, { output: this.headlines.map((title, index) => ({ id: `h${index}`, title, ...kept })) });
      }
      if (rest === "jobs/refresh" && method === "GET") return json(200, this.job);
      if (rest === "jobs/refresh/run" && method === "POST") {
        // As on the server: during a run, asking changes nothing.
        if (this.job.state !== "running") this.job = { ...this.job, state: "requested" };
        return json(202, this.job);
      }
    }
    return json(404, { error: { code: "not_found", message: "No such route" } });
  }
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function start(server: FakeServer, options: { at?: string; apps?: readonly BundledApp[] } = {}) {
  vi.stubGlobal("fetch", server.fetch);
  const client = new QueryClient();
  render(
    <MemoryRouter initialEntries={[options.at ?? "/"]}>
      <BundledAppsProvider apps={options.apps ?? [CHECKLIST, FEED]}>
        <App queryClient={client} />
        <Where />
      </BundledAppsProvider>
    </MemoryRouter>,
  );
  return client;
}

const card = async (name: string) => (await screen.findByRole("heading", { level: 2, name })).closest("section") as HTMLElement;
const checklistApp = (extra: Partial<AppSummary> = {}) => summary(checklistManifest, PERSONAL, { hasPage: true, ...extra });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a widget on the dashboard", () => {
  it("is drawn inside the app's card, after a skeleton, with the app's own strings", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, FAMILY)]);
    start(server);

    const checklist = await card("Checklist");
    expect(within(checklist).getByTestId("app-skeleton").textContent).toBe("Loading…");
    expect(await within(checklist).findByRole("checkbox", { name: "Water the plants" })).toBeTruthy();
    expect(within(checklist).getByText("2 left")).toBeTruthy();
    expect(within(checklist).queryByTestId("app-skeleton")).toBeNull();
    // The frame is the shell's: the link to the page, and no tag for a personal space.
    expect(within(checklist).getByRole("link", { name: /Open/ }).getAttribute("href")).toBe(`/apps/${PERSONAL}/checklist`);

    const feed = await card("Feed");
    expect(await within(feed).findByText("Following every topic")).toBeTruthy();
    expect(within(feed).getByText("Family")).toBeTruthy();
    expect(within(feed).queryByRole("link")).toBeNull();

    // Each app was asked about in its own space, by the names its code used.
    expect(server.count(`POST /api/spaces/${PERSONAL}/apps/checklist/q/list`)).toBe(1);
    expect(server.count(`GET /api/spaces/${FAMILY}/apps/feed/settings`)).toBe(1);
  });

  it("speaks the reader's language", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()], { locale: "zh" });
    start(server);
    const checklist = await card("清单");
    expect(await within(checklist).findByText("还剩 2 项")).toBeTruthy();
    expect(within(checklist).getByRole("link", { name: /打开/ })).toBeTruthy();
  });

  it("gets its settings: the space's and the reader's own, by name", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
    server.settings.feed = { space: {}, user: { topics: ["food", "science"], period: "week" } };
    start(server);
    expect(await within(await card("Feed")).findByText("Following 2 topics")).toBeTruthy();
  });

  it("ticks an item, reads the list again, and the app's page then shows it ticked", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    start(server);
    const checklist = await card("Checklist");

    fireEvent.click(await within(checklist).findByRole("checkbox", { name: "Water the plants" }));
    await waitFor(() => expect(within(checklist).queryByRole("checkbox", { name: "Water the plants" })).toBeNull());
    expect(within(checklist).getByText("1 left")).toBeTruthy();
    expect(server.bodies).toContainEqual({ input: { id: "i1", done: true } });
    expect(server.count("/checklist/m/tick")).toBe(1);
    expect(server.count("/checklist/q/list")).toBe(2);

    fireEvent.click(within(checklist).getByRole("link", { name: /Open/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Checklist" })).toBeTruthy();
    const ticked = (await screen.findByRole("checkbox", { name: "Water the plants" })) as HTMLInputElement;
    expect(ticked.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Book the dentist" }) as HTMLInputElement).checked).toBe(false);
  });

  it("names the card and its link with the group, so that the same app in two spaces can be told apart", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), checklistApp({ spaceId: FAMILY })]);
    start(server);
    const own = await screen.findByRole("region", { name: "Checklist" });
    const family = screen.getByRole("region", { name: "Checklist in Family" });
    // The test's reading of names drops the space between "Open" and the hidden rest; a browser keeps it.
    expect(within(own).getByRole("link", { name: /^Open ?Checklist$/ }).getAttribute("href")).toBe(`/apps/${PERSONAL}/checklist`);
    expect(within(family).getByRole("link", { name: /^Open ?Checklist in Family$/ }).getAttribute("href")).toBe(`/apps/${FAMILY}/checklist`);

    // The page of the one in the group names the group beside the title.
    fireEvent.click(within(family).getByRole("link", { name: /^Open ?Checklist in Family$/ }));
    const title = await screen.findByRole("heading", { level: 1, name: "Checklist" });
    expect(within(title.closest("header") as HTMLElement).getByText("Family")).toBeTruthy();
  });

  it("lets someone with view access look and not tick", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp({ access: "view" })]);
    start(server);
    const box = (await within(await card("Checklist")).findByRole("checkbox", { name: "Water the plants" })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it("says so under the widget when a change could not be saved, and why when it was not allowed", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    start(server);
    const checklist = await card("Checklist");
    const box = () => within(checklist).findByRole("checkbox", { name: "Water the plants" });

    server.refuse = { ending: "/m/tick", with: { status: 500, code: "internal" } };
    fireEvent.click(await box());
    expect(await within(checklist).findByText("That change could not be saved. Try again.")).toBeTruthy();
    expect(server.items[0]?.done).toBe(false);

    server.refuse = { ending: "/m/tick", with: { status: 403, code: "forbidden" } };
    fireEvent.click(await box());
    expect(await within(checklist).findByText("You can look at this app, but not change anything in it.")).toBeTruthy();

    // The next change that goes through takes the notice away.
    server.refuse = null;
    fireEvent.click(await box());
    await waitFor(() => expect(within(checklist).queryByRole("checkbox", { name: "Water the plants" })).toBeNull());
    expect(within(checklist).queryByText(/could not be saved|but not change/)).toBeNull();
  });

  it("reads the app again when the server turns a change down, and does not ask to try again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    start(server);
    const checklist = await card("Checklist");
    const box = await within(checklist).findByRole("checkbox", { name: "Water the plants" });
    expect(server.count("/checklist/q/list")).toBe(1);

    // Someone else cleared the item a moment ago; ticking it now finds nothing.
    server.items = server.items.filter((item) => item.id !== "i1");
    fireEvent.click(box);
    expect(await within(checklist).findByText("That change was not made. The app now shows what is saved.")).toBeTruthy();
    // Read again at once, not at the next poll: the item that is gone has gone from the screen too.
    expect(within(checklist).queryByRole("checkbox", { name: "Water the plants" })).toBeNull();
    expect(within(checklist).getByText("1 left")).toBeTruthy();
    expect(server.count("/checklist/q/list")).toBe(2);

    for (const code of ["conflict", "invalid_request"]) {
      server.refuse = { ending: "/m/tick", with: { status: code === "conflict" ? 409 : 400, code } };
      fireEvent.click(await within(checklist).findByRole("checkbox", { name: "Book the dentist" }));
      await waitFor(() => expect(server.count("/checklist/q/list")).toBe(code === "conflict" ? 3 : 4));
      expect(within(checklist).getByText("That change was not made. The app now shows what is saved.")).toBeTruthy();
      expect(within(checklist).queryByText(/Try again/)).toBeNull();
    }
  });

  it("shows a failed state in the card when the app cannot be loaded, and loads it on another try", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, PERSONAL)]);
    server.refuse = { ending: "/q/list", with: { status: 500, code: "internal" } };
    start(server);
    const checklist = await card("Checklist");

    expect(await within(checklist).findByText("This app could not be loaded.")).toBeTruthy();
    // The card stays, with its frame, and the other app is not affected.
    expect(within(checklist).getByRole("link", { name: /Open/ })).toBeTruthy();
    expect(await within(await card("Feed")).findByText("Following every topic")).toBeTruthy();

    server.refuse = null;
    fireEvent.click(within(checklist).getByRole("button", { name: "Try again" }));
    expect(await within(checklist).findByRole("checkbox", { name: "Water the plants" })).toBeTruthy();
    expect(within(checklist).queryByText("This app could not be loaded.")).toBeNull();
  });

  it("keeps a fault in an app's own code inside that app's card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: BundledApp = {
      ...FEED,
      widget: async () => ({
        default: () => {
          throw new Error("Sample fault");
        },
      }),
    };
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, PERSONAL)]);
    start(server, { apps: [CHECKLIST, broken] });
    expect(await within(await card("Feed")).findByText("This app could not be loaded.")).toBeTruthy();
    expect(await within(await card("Checklist")).findByRole("checkbox", { name: "Water the plants" })).toBeTruthy();
  });

  it("asks for the session again when the server says the app is not there, and the card goes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, PERSONAL)]);
    start(server);
    const checklist = await card("Checklist");
    const box = await within(checklist).findByRole("checkbox", { name: "Water the plants" });
    expect(server.count("GET /api/session")).toBe(1);

    // Someone removed the app, or took this person's access away, while the page was open.
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
    server.refuse = { ending: "/m/tick", with: { status: 404, code: "not_found" } };
    fireEvent.click(box);

    await waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Checklist" })).toBeNull());
    expect(server.count("GET /api/session")).toBe(2);
    expect(screen.getByRole("heading", { level: 2, name: "Feed" })).toBeTruthy();
    expect(server.items[0]?.done).toBe(false);
    // An app that went is not asked for its list again: that would only find it gone once more.
    expect(server.count("/checklist/q/list")).toBe(1);
  });

  it("reads the list again after the session when the not_found was about a row, and the app is still there", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    start(server);
    const checklist = await card("Checklist");
    const box = await within(checklist).findByRole("checkbox", { name: "Water the plants" });

    // Someone else deleted the item a moment ago.
    server.items = server.items.filter((item) => item.id !== "i1");
    fireEvent.click(box);

    await waitFor(() => expect(within(checklist).queryByRole("checkbox", { name: "Water the plants" })).toBeNull());
    expect(server.count("GET /api/session")).toBe(2);
    expect(server.count("/checklist/q/list")).toBe(2);
    expect(within(checklist).getByRole("checkbox", { name: "Book the dentist" })).toBeTruthy();
  });

  it("does the same when it is a query that finds the app gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    server.sessionAfterwards = sessionWith([]);
    server.refuse = { ending: "/q/list", with: { status: 404, code: "not_found" } };
    start(server);
    expect(await screen.findByRole("heading", { name: "No widgets yet" })).toBeTruthy();
    expect(server.count("GET /api/session")).toBe(2);
  });

  it("offers a reload when the session lists an app this build does not hold", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, PERSONAL)]);
    start(server, { apps: [FEED] });

    const checklist = await card("Checklist");
    expect(within(checklist).getByText("Hearth has been updated since you opened this page.")).toBeTruthy();
    fireEvent.click(within(checklist).getByRole("button", { name: "Reload to update" }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    // Nothing was asked of the server about an app whose code is not here.
    expect(server.count("/checklist/q/list")).toBe(0);
    expect(await within(await card("Feed")).findByText("Following every topic")).toBeTruthy();
  });

  it("offers a reload when the app's code can no longer be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gone: BundledApp = { ...FEED, widget: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")) };
    const server = new FakeServer();
    server.session = sessionWith([summary(feedManifest, PERSONAL)]);
    start(server, { apps: [gone] });
    expect(await within(await card("Feed")).findByRole("button", { name: "Reload to update" })).toBeTruthy();
  });

  it("takes the room its app asked for", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, PERSONAL)]);
    start(server);
    expect((await card("Checklist")).className).toContain("row-span-2");
    expect((await card("Feed")).className).toContain("col-span-2");
  });
});

describe("an app's page", () => {
  it("lists, adds, ticks and clears through the app's routes", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp({ spaceId: FAMILY })]);
    server.settings.checklist = { space: { sections: ["Home", "Garden"] }, user: { hideDone: false } };
    server.items = [
      { id: "i1", name: "Water the plants", section: "Garden", done: false },
      { id: "i2", name: "Book the dentist", section: "", done: true },
      { id: "i3", name: "Old errand", section: "Shed", done: false },
    ];
    start(server, { at: `/apps/${FAMILY}/checklist` });

    expect(await screen.findByRole("heading", { level: 1, name: "Checklist" })).toBeTruthy();
    // Grouped by the space's sections; what has none, or one that is gone, is under "Other".
    const garden = await screen.findByRole("region", { name: "Garden" });
    expect(within(garden).getByRole("checkbox", { name: "Water the plants" })).toBeTruthy();
    const other = screen.getByRole("region", { name: "Other" });
    expect(within(other).getAllByRole("checkbox").map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);
    expect(screen.queryByRole("region", { name: "Home" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Add an item" }), { target: { value: "Sweep the hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const home = await screen.findByRole("region", { name: "Home" });
    expect(within(home).getByRole("checkbox", { name: "Sweep the hall" })).toBeTruthy();
    expect(server.bodies).toContainEqual({ input: { name: "Sweep the hall", section: "Home" } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Add an item" }) as HTMLInputElement).value).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: "Clear ticked" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Book the dentist" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Clear ticked" })).toBeNull();
    expect(server.items.map((item) => item.name)).toEqual(["Water the plants", "Old errand", "Sweep the hall"]);
  });

  it("follows the reader's own setting, and gives a viewer nothing to press", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp({ access: "view" })]);
    server.settings.checklist = { space: { sections: [] }, user: { hideDone: true } };
    server.items = [
      { id: "i1", name: "Water the plants", section: "", done: true },
      { id: "i2", name: "Book the dentist", section: "", done: false },
    ];
    start(server, { at: `/apps/${PERSONAL}/checklist` });

    expect(await screen.findByRole("checkbox", { name: "Book the dentist" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Water the plants" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: "Book the dentist" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear ticked" })).toBeNull();
  });

  it("is there under any address that starts with the app's, and not for an app without a page", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp(), summary(feedManifest, PERSONAL)]);
    start(server, { at: `/apps/${PERSONAL}/checklist/archive/2026` });
    expect(await screen.findByRole("heading", { level: 1, name: "Checklist" })).toBeTruthy();
    expect(await screen.findByRole("checkbox", { name: "Water the plants" })).toBeTruthy();

    cleanup();
    start(server, { at: `/apps/${PERSONAL}/feed` });
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
  });

  it("offers a reload when this build holds the app without its page", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    start(server, { at: `/apps/${PERSONAL}/checklist`, apps: [{ ...CHECKLIST, hasPage: false, page: undefined }] });
    expect(await screen.findByRole("button", { name: "Reload to update" })).toBeTruthy();
  });
});

describe("what a widget is handed", () => {
  const manifest = defineApp({
    id: "probe",
    name: { en: "Probe", zh: "探针" },
    description: { en: "Shows what a widget is given.", zh: "显示小组件得到的内容。" },
    icon: "box",
    color: "blue",
    widget: { size: "small" },
    messages: { en: { hello: "Hello, {name}" }, zh: { hello: "你好，{name}" } },
  });
  const { useApp } = appHooks<typeof manifest>();
  function Probe() {
    const { t, locale, user, space, access, canEdit, settings, pagePath } = useApp();
    return (
      <div>
        <p data-testid="probe">
          {JSON.stringify({ hello: t("hello", { name: user.name }), locale, user, space, access, canEdit, settings, pagePath })}
        </p>
        {pagePath ? <a href={pagePath}>To the page</a> : null}
      </div>
    );
  }
  const PROBE: BundledApp = {
    id: "probe",
    manifest,
    hasPage: true,
    widget: async () => ({ default: Probe }),
    page: async () => ({ default: () => <p>The probe's page</p> }),
  };

  it("is the reader, the space with its members, the access level and the page's address, and no IDs of spaces", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(manifest, FAMILY, { access: "view", hasPage: true })]);
    start(server, { apps: [PROBE] });
    const given = JSON.parse((await screen.findByTestId("probe")).textContent ?? "") as unknown;
    expect(given).toEqual({
      hello: "Hello, Sam Example",
      locale: "en",
      user: { id: "u1", name: "Sam Example" },
      space: {
        kind: "group",
        name: "Family",
        members: [
          { id: "u1", name: "Sam Example" },
          { id: "u2", name: "Lin Example" },
        ],
      },
      access: "view",
      canEdit: false,
      settings: {},
      pagePath: `/apps/${FAMILY}/probe`,
    });
    // An app that declares no settings has none to ask for.
    expect(server.count("/settings")).toBe(0);
  });

  it("can link to its own page, which opens without loading Hearth again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([summary(manifest, PERSONAL, { hasPage: true })]);
    start(server, { apps: [PROBE] });
    fireEvent.click(await screen.findByRole("link", { name: "To the page" }));
    expect(await screen.findByText("The probe's page")).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe(`/apps/${PERSONAL}/probe`);
    expect(server.count("GET /api/session")).toBe(1);
  });
});

describe("keeping a widget up to date", () => {
  /** Lets everything that is due happen: timers, answers, and the drawing that follows. */
  const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const names = () => screen.queryAllByRole("checkbox").map((box) => box.closest("label")?.textContent);
  const setVisible = async (visible: boolean) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visible ? "visible" : "hidden");
    await act(async () => void window.dispatchEvent(new Event("visibilitychange")));
  };

  async function open(server: FakeServer) {
    // The widget's code is fetched before the clock is stopped, as it would be from the browser's cache.
    await CHECKLIST.widget();
    vi.useFakeTimers();
    start(server);
    for (let round = 0; round < 10 && names().length === 0; round += 1) await settle(10);
    expect(names()).toEqual(["Water the plants", "Book the dentist"]);
  }

  it("reads an app's queries again every 15 seconds, so that other people's changes appear", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    await open(server);
    expect(server.count("/q/list")).toBe(1);

    // Someone else in the space adds an item. Nothing is pushed; the next reading brings it.
    server.items.push({ id: "i9", name: "Feed the cat", section: "", done: false });
    await settle(REFRESH_EVERY_MS - 1000);
    expect(server.count("/q/list")).toBe(1);
    expect(names()).not.toContain("Feed the cat");
    await settle(1100);
    expect(server.count("/q/list")).toBe(2);
    expect(names()).toContain("Feed the cat");
    // The settings are read again with them: the space's can be changed by others too.
    expect(server.count("/settings")).toBe(2);

    await settle(REFRESH_EVERY_MS);
    expect(server.count("/q/list")).toBe(3);
  });

  it("stops while the window is hidden, and reads at once when it is looked at again", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    await open(server);

    await setVisible(false);
    server.items.push({ id: "i9", name: "Feed the cat", section: "", done: false });
    await settle(REFRESH_EVERY_MS * 3);
    expect(server.count("/q/list")).toBe(1);

    await setVisible(true);
    await settle(20);
    expect(server.count("/q/list")).toBe(2);
    expect(names()).toContain("Feed the cat");
  });

  it("keeps showing what it has when a later reading fails", async () => {
    const server = new FakeServer();
    server.session = sessionWith([checklistApp()]);
    await open(server);
    server.refuse = { ending: "/q/list", with: { status: 500, code: "internal" } };
    await settle(REFRESH_EVERY_MS + 100);
    expect(server.count("/q/list")).toBe(2);
    expect(names()).toEqual(["Water the plants", "Book the dentist"]);
    expect(screen.queryByText("This app could not be loaded.")).toBeNull();
  });
});

describe("a job in a widget", () => {
  const manifest = defineApp({
    id: "ticker",
    name: { en: "Ticker", zh: "快讯" },
    description: { en: "Keeps the latest headlines of a feed.", zh: "保存一个订阅源的最新标题。" },
    icon: "file-text",
    color: "teal",
    widget: { size: "small" },
    network: ["feeds.example.com"],
  });
  const ticker = defineServer(manifest, { headlines: z.object({ title: z.string() }) });
  const server = ticker.routes({
    latest: ticker.query({ description: "Lists the headlines kept, newest first." }, (ctx) => ctx.db.headlines.list({ desc: true })),
    refresh: ticker.job({ description: "Keeps the latest headlines of the feed, every hour.", everyMinutes: 60 }, () => {}),
  });
  const { useQuery, useJob } = appHooks<typeof server>();

  /** What the last `run()` came to. */
  let outcome: "asked" | "refused" | null;
  function Ticker() {
    const headlines = useQuery("latest");
    const job = useJob("refresh");
    const { succeededAt, failedAt, running, canRun, pending } = job;
    const refresh = () =>
      job.run().then(
        () => void (outcome = "asked"),
        () => void (outcome = "refused"),
      );
    return (
      <div>
        <ul aria-label="Headlines">
          {headlines.map((headline) => (
            <li key={headline.id}>{headline.title}</li>
          ))}
        </ul>
        <output data-testid="job">{JSON.stringify({ succeededAt, failedAt, running, canRun, pending })}</output>
        <button type="button" disabled={pending} onClick={() => void refresh()}>
          Refresh now
        </button>
      </div>
    );
  }
  // The build's list holds the manifest, which the server file carries too.
  const TICKER: BundledApp = { id: "ticker", manifest: server.manifest, hasPage: false, widget: async () => ({ default: Ticker }) };

  const STARTED = "2026-03-01T13:05:00.000Z";
  const SUCCEEDED = "2026-03-01T13:05:21.000Z";
  const LATER = "2026-03-01T14:05:30.000Z";
  const STATUS = `GET /api/spaces/${FAMILY}/apps/ticker/jobs/refresh`;
  const RUN = `POST /api/spaces/${FAMILY}/apps/ticker/jobs/refresh/run`;
  const QUERY = `POST /api/spaces/${FAMILY}/apps/ticker/q/latest`;

  const tickerApp = (extra: Partial<AppSummary> = {}) => summary(manifest, FAMILY, extra);
  /** What the widget shows of its job. */
  const shown = () =>
    JSON.parse(screen.getByTestId("job").textContent ?? "") as {
      succeededAt: string | null;
      failedAt: string | null;
      running: boolean;
      canRun: boolean;
      pending: boolean;
    };
  const headlines = () =>
    within(screen.getByRole("list", { name: "Headlines" }))
      .queryAllByRole("listitem")
      .map((item) => item.textContent);
  /** A promise the test resolves when it likes, to hold an answer back. */
  function gate() {
    let open = () => {};
    const until = new Promise<void>((resolve) => (open = resolve));
    return { until, open };
  }
  /** Lets everything that is due happen: timers, answers, and the drawing that follows. */
  const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  async function open(server: FakeServer) {
    vi.useFakeTimers();
    start(server, { apps: [TICKER] });
    for (let round = 0; round < 20 && screen.queryByTestId("job") === null; round += 1) await settle(10);
    expect(screen.getByTestId("job")).toBeTruthy();
  }

  afterEach(() => {
    outcome = null;
  });

  it("waits for the job's status before the widget is drawn, as for a query", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    const held = gate();
    server.hold = { ending: "/jobs/refresh", until: held.until };
    start(server, { apps: [TICKER] });
    const card = (await screen.findByRole("heading", { level: 2, name: /Ticker/ })).closest("section") as HTMLElement;

    await waitFor(() => expect(server.count(STATUS)).toBe(1));
    expect(within(card).getByTestId("app-skeleton")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Refresh now" })).toBeNull();

    held.open();
    expect(await within(card).findByRole("button", { name: "Refresh now" })).toBeTruthy();
    expect(within(card).queryByTestId("app-skeleton")).toBeNull();
    expect(shown()).toEqual({ succeededAt: null, failedAt: null, running: false, canRun: true, pending: false });
    expect(headlines()).toEqual(["Rain expected", "Market opens"]);
  });

  it("reads the status every 3 seconds while a run is going on or asked for, and with the queries otherwise", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    server.job = { ...NOT_RUN, lastStartedAt: STARTED, state: "running" };
    await open(server);
    expect(shown().running).toBe(true);
    expect(server.count(STATUS)).toBe(1);

    await settle(RUNNING_REFRESH_MS - 100);
    expect(server.count(STATUS)).toBe(1);
    await settle(200);
    expect(server.count(STATUS)).toBe(2);
    await settle(RUNNING_REFRESH_MS);
    expect(server.count(STATUS)).toBe(3);

    // The run ends: from then on the status is read every 15 seconds, as the queries are.
    server.job = { ...server.job, lastSucceededAt: SUCCEEDED, state: "idle" };
    await settle(RUNNING_REFRESH_MS);
    expect(server.count(STATUS)).toBe(4);
    expect(shown()).toMatchObject({ running: false, succeededAt: SUCCEEDED });
    await settle(REFRESH_EVERY_MS - 1000);
    expect(server.count(STATUS)).toBe(4);
    await settle(1100);
    expect(server.count(STATUS)).toBe(5);

    // A run asked for that has not started counts as going on.
    server.job = { ...server.job, state: "requested" };
    await settle(REFRESH_EVERY_MS);
    expect(server.count(STATUS)).toBe(6);
    expect(shown().running).toBe(true);
    await settle(RUNNING_REFRESH_MS);
    expect(server.count(STATUS)).toBe(7);
  });

  it("reads the app's queries again once a run went well, and shows the new status with what the run brought", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    server.job = { ...NOT_RUN, lastStartedAt: LATER, lastSucceededAt: SUCCEEDED, state: "running" };
    await open(server);
    expect(server.count(QUERY)).toBe(1);

    // Still running: nothing new to read.
    await settle(RUNNING_REFRESH_MS);
    expect(server.count(STATUS)).toBe(2);
    expect(server.count(QUERY)).toBe(1);

    // The run went well and brought a new headline. Until the query has answered, the widget shows
    // the old status beside the old headlines, never the new status beside them.
    server.job = { ...server.job, lastSucceededAt: LATER, state: "idle" };
    server.headlines = ["Snow in the hills", "Rain expected"];
    const held = gate();
    server.hold = { ending: "/q/latest", until: held.until };
    await settle(RUNNING_REFRESH_MS);
    // Whatever was to be drawn by now has been drawn.
    await settle(500);
    expect(server.count(STATUS)).toBe(3);
    expect(server.count(QUERY)).toBe(2);
    expect(shown()).toMatchObject({ succeededAt: SUCCEEDED, running: true });
    expect(headlines()).toEqual(["Rain expected", "Market opens"]);

    held.open();
    await settle(10);
    expect(headlines()).toEqual(["Snow in the hills", "Rain expected"]);
    expect(shown()).toMatchObject({ succeededAt: LATER, running: false });
    // A status read again with the same run gone well asks for nothing more.
    server.hold = null;
    await settle(REFRESH_EVERY_MS);
    expect(server.count(STATUS)).toBe(4);
    expect(server.count(QUERY)).toBe(3);
  });

  it("asks for a run, shows it going on at once, and is pending until the server answered", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    server.job = { ...NOT_RUN, lastStartedAt: STARTED, lastSucceededAt: SUCCEEDED };
    await open(server);
    expect(shown()).toMatchObject({ running: false, canRun: true, pending: false });

    const held = gate();
    server.hold = { ending: "/jobs/refresh/run", until: held.until };
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await settle(10);
    expect(server.count(RUN)).toBe(1);
    expect(shown()).toMatchObject({ running: false, pending: true });
    expect((screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement).disabled).toBe(true);

    held.open();
    await settle(10);
    expect(outcome).toBe("asked");
    // The answer is the status: no reading of it was needed to show the run asked for.
    expect(shown()).toMatchObject({ running: true, pending: false });
    expect(server.count(STATUS)).toBe(1);
    // From then on it is read every 3 seconds, to see the run end.
    server.hold = null;
    await settle(RUNNING_REFRESH_MS);
    expect(server.count(STATUS)).toBe(2);
    expect(screen.queryByText(/could not be saved|but not change|was not made/)).toBeNull();
  });

  it("keeps showing the run asked for when a reading of the status sent before it arrives after it", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    server.job = { ...NOT_RUN, lastStartedAt: STARTED, lastSucceededAt: SUCCEEDED };
    await open(server);
    // A reading of the status is on its way, slowly, when the person asks for a run.
    const slow = gate();
    server.hold = { ending: "/jobs/refresh", until: slow.until };
    await settle(REFRESH_EVERY_MS);
    expect(server.count(STATUS)).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await settle(10);
    expect(shown()).toMatchObject({ running: true, pending: false });

    // It says what was true before the request, and is not taken.
    slow.open();
    await settle(500);
    expect(shown()).toMatchObject({ running: true });
  });

  it("reports a run the server refused as a refused change, and reads the app again", async () => {
    const server = new FakeServer();
    // The session still says edit; an owner has just made this person a viewer.
    server.session = sessionWith([tickerApp()]);
    await open(server);
    server.refuse = { ending: "/jobs/refresh/run", with: { status: 403, code: "forbidden" } };
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await settle(10);
    expect(outcome).toBe("refused");
    expect(screen.getByText("You can look at this app, but not change anything in it.")).toBeTruthy();
    expect(shown()).toMatchObject({ running: false, pending: false });
    expect(server.count(STATUS)).toBe(2);
    expect(server.count(QUERY)).toBe(2);

    // The next run asked for that goes through takes the notice away.
    server.refuse = null;
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await settle(10);
    expect(outcome).toBe("asked");
    expect(screen.queryByText("You can look at this app, but not change anything in it.")).toBeNull();
    expect(shown().running).toBe(true);
  });

  it("asks for the session again when the server says the app is not there, and the card goes", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp(), checklistApp()]);
    await open(server);
    server.session = sessionWith([checklistApp()]);
    server.refuse = { ending: "/jobs/refresh/run", with: { status: 404, code: "not_found" } };
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await settle(10);
    await settle(10);
    expect(outcome).toBe("refused");
    expect(screen.queryByRole("heading", { level: 2, name: /Ticker/ })).toBeNull();
    expect(server.count("GET /api/session")).toBe(2);
    expect(screen.getByRole("heading", { level: 2, name: "Checklist" })).toBeTruthy();
  });

  it("lets only someone with edit access ask for a run", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp({ access: "view" })]);
    await open(server);
    expect(shown().canRun).toBe(false);
  });

  it("says when the last run failed, until one goes well", async () => {
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    server.job = { ...NOT_RUN, lastStartedAt: LATER, lastSucceededAt: SUCCEEDED, lastFailedAt: LATER, lastError: "The feed answered 500." };
    await open(server);
    expect(shown()).toMatchObject({ succeededAt: SUCCEEDED, failedAt: LATER });
    // The message itself is the server's, in English: the widget is not given it.
    expect(screen.getByTestId("job").textContent).not.toContain("500");

    server.job = { ...server.job, lastSucceededAt: "2026-03-01T14:10:00.000Z" };
    await settle(REFRESH_EVERY_MS + 100);
    expect(shown()).toMatchObject({ succeededAt: "2026-03-01T14:10:00.000Z", failedAt: null });
  });

  it("fails the card as a query does when the status cannot be read, and reads it on another try", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new FakeServer();
    server.session = sessionWith([tickerApp()]);
    server.refuse = { ending: "/jobs/refresh", with: { status: 500, code: "internal" } };
    start(server, { apps: [TICKER] });
    const card = (await screen.findByRole("heading", { level: 2, name: /Ticker/ })).closest("section") as HTMLElement;
    expect(await within(card).findByText("This app could not be loaded.")).toBeTruthy();

    server.refuse = null;
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await within(card).findByRole("button", { name: "Refresh now" })).toBeTruthy();
    expect(shown().succeededAt).toBeNull();
  });
});

describe("an app's own strings", () => {
  const manifest = defineApp({
    id: "probe",
    name: { en: "Probe", zh: "探针" },
    description: { en: "Sample.", zh: "示例。" },
    icon: "box",
    color: "blue",
    widget: { size: "small" },
    messages: { en: { left: "{count} of {total} left", plain: "Nothing to do." }, zh: { left: "还剩 {count}/{total} 项", plain: "没有待办事项。" } },
  });

  it("are looked up in the reader's language, with placeholders filled", () => {
    expect(appTranslator(manifest, "en")("left", { count: 2, total: 5 })).toBe("2 of 5 left");
    expect(appTranslator(manifest, "zh")("left", { count: 2, total: 5 })).toBe("还剩 2/5 项");
    expect(appTranslator(manifest, "zh")("plain")).toBe("没有待办事项。");
  });

  it("leave a placeholder without a value as it is, and show an unknown key as the key", () => {
    const t = appTranslator(manifest, "en");
    expect(t("left", { count: 2 })).toBe("2 of {total} left");
    expect(t("missing")).toBe("missing");
    expect(t("constructor")).toBe("constructor");
    const none = defineApp({ ...manifest, messages: undefined });
    expect(appTranslator(none, "zh")("plain")).toBe("plain");
  });

  it("fall back to English when the reader's language lacks one", () => {
    const partial = { ...manifest, messages: { en: { left: "{count} of {total} left", plain: "Nothing to do." }, zh: { left: "", plain: "" } } } as Manifest;
    expect(appTranslator(partial, "zh")("plain")).toBe("Nothing to do.");
  });
});
