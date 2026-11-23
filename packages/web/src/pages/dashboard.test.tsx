/**
 * Apps on the dashboard and on their own page: the frame the shell draws
 * around each app made in Hearth, and the app's page in its sandbox inside
 * it. The whole web app is drawn against a stand-in for the server that
 * answers the session; the sandboxed pages themselves are the server's.
 */
import type { AppSummary, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

const PERSONAL = "space-personal";
const FAMILY = "space-family";

/** An app made in Hearth, as the session lists it. */
function made(id: string, name: { en: string; zh: string }, spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    spaceId,
    name,
    description: { en: `${name.en}, made in Hearth.`, zh: `${name.zh}，在 Hearth 里做的。` },
    icon: "list-checks",
    color: "teal",
    widgetSize: "wide",
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: true,
    made: true,
    version: 1,
    ...extra,
  };
}

const GROCERY = { en: "Grocery list", zh: "购物清单" };
const IDEAS = { en: "Ideas", zh: "想法" };

function sessionWith(apps: AppSummary[], user: Partial<Session["user"]> = {}): Session {
  const me = { id: "u1", email: "sam@example.com", name: "Sam Example", locale: "en" as const, theme: "light" as const, ...user };
  return {
    user: me,
    spaces: [
      { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, assistant: "none", members: [{ id: me.id, name: me.name, role: "owner" }] },
      {
        id: FAMILY,
        kind: "group",
        name: "Family",
        role: "owner",
        canAddApps: true,
        assistant: "none",
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

/** Answers the session; nothing else is asked of it while nobody opens a dialog. */
function start(session: Session, at = "/") {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push(`${init.method ?? "GET"} ${String(input)}`);
    if (String(input) === "/api/session") return new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: { code: "not_found", message: "No such route." } }), { status: 404 });
  });
  render(
    <MemoryRouter initialEntries={[at]}>
      <App queryClient={new QueryClient()} />
    </MemoryRouter>,
  );
  return requests;
}

const card = async (name: string) => (await screen.findByRole("heading", { level: 2, name })).closest("section") as HTMLElement;
/** Where an app's page is drawn in its sandbox, and what it was asked to draw. */
const frameIn = (element: HTMLElement) => element.querySelector("iframe") as HTMLIFrameElement;
const frameUrl = (frame: HTMLIFrameElement) => new URL(frame.getAttribute("src") ?? "", "http://localhost");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an app on the dashboard", () => {
  it("draws its page small in its card, in the sandbox, inside the shell's frame", async () => {
    const requests = start(sessionWith([made("m-aaaaaaaaaa", GROCERY, PERSONAL), made("m-bbbbbbbbbb", IDEAS, FAMILY, { version: 3 })]));

    const grocery = await card("Grocery list");
    const frame = frameIn(grocery);
    expect(frame.getAttribute("data-made-app")).toBe("m-aaaaaaaaaa");
    expect(frame.getAttribute("title")).toBe("Grocery list");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
    const url = frameUrl(frame);
    expect(url.pathname).toBe(`/api/spaces/${PERSONAL}/apps/m-aaaaaaaaaa/frame`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ theme: "light", locale: "en", view: "card", v: "1" });
    // The frame is the shell's: the link to the page, and no tag for a personal space.
    expect(within(grocery).getByRole("link", { name: /Open/ }).getAttribute("href")).toBe(`/apps/${PERSONAL}/m-aaaaaaaaaa`);
    expect(within(grocery).queryByText("Family")).toBeNull();

    const ideas = await card("Ideas");
    expect(within(ideas).getByText("Family")).toBeTruthy();
    // A new version of the app draws its page afresh.
    expect(frameUrl(frameIn(ideas)).searchParams.get("v")).toBe("3");
    // The page asks the server itself: the shell asked for nothing but the session.
    expect(requests).toEqual(["GET /api/session"]);
  });

  it("speaks the reader's language, and has the page drawn in it", async () => {
    start(sessionWith([made("m-aaaaaaaaaa", GROCERY, PERSONAL)], { locale: "zh" }));
    const grocery = await card("购物清单");
    expect(within(grocery).getByRole("link", { name: /打开/ })).toBeTruthy();
    expect(frameUrl(frameIn(grocery)).searchParams.get("locale")).toBe("zh");
    expect(frameIn(grocery).getAttribute("title")).toBe("购物清单");
  });

  it("names the card and its link with the group, so that apps of the same name in two spaces can be told apart", async () => {
    start(sessionWith([made("m-aaaaaaaaaa", GROCERY, PERSONAL), made("m-bbbbbbbbbb", GROCERY, FAMILY)]));
    const own = await screen.findByRole("region", { name: "Grocery list" });
    const family = screen.getByRole("region", { name: "Grocery list in Family" });
    // The test's reading of names drops the space between "Open" and the hidden rest; a browser keeps it.
    expect(within(own).getByRole("link", { name: /^Open ?Grocery list$/ }).getAttribute("href")).toBe(`/apps/${PERSONAL}/m-aaaaaaaaaa`);
    expect(within(family).getByRole("link", { name: /^Open ?Grocery list in Family$/ }).getAttribute("href")).toBe(
      `/apps/${FAMILY}/m-bbbbbbbbbb`,
    );

    // The page of the one in the group names the group beside the title, and draws that app whole.
    fireEvent.click(within(family).getByRole("link", { name: /^Open ?Grocery list in Family$/ }));
    const title = await screen.findByRole("heading", { level: 1, name: "Grocery list" });
    expect(within(title.closest("header") as HTMLElement).getByText("Family")).toBeTruthy();
    const page = document.querySelector<HTMLElement>('[data-app-page="m-bbbbbbbbbb"]')!;
    expect(frameUrl(frameIn(page)).searchParams.get("view")).toBe("page");
  });

  it("takes the room its app asked for", async () => {
    start(
      sessionWith([
        made("m-aaaaaaaaaa", GROCERY, PERSONAL, { widgetSize: "tall" }),
        made("m-bbbbbbbbbb", IDEAS, PERSONAL, { widgetSize: "wide" }),
        made("m-cccccccccc", { en: "Ledger", zh: "账本" }, PERSONAL, { widgetSize: "large" }),
        made("m-dddddddddd", { en: "Weather", zh: "天气" }, PERSONAL, { widgetSize: "small" }),
      ]),
    );
    expect((await card("Grocery list")).className).toContain("row-span-2");
    expect((await card("Ideas")).className).toContain("col-span-2");
    expect((await card("Ledger")).className).toMatch(/col-span-2 row-span-2/);
    expect((await card("Weather")).className).not.toMatch(/span-2/);
  });

  it("is left out when the person switched it off", async () => {
    start(sessionWith([made("m-aaaaaaaaaa", GROCERY, PERSONAL), made("m-bbbbbbbbbb", IDEAS, PERSONAL, { enabled: false })]));
    const grid = await screen.findByTestId("widget-grid");
    expect(within(grid).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Grocery list"]);
    expect(document.querySelector('iframe[data-made-app="m-bbbbbbbbbb"]')).toBeNull();
  });
});

describe("an app's page", () => {
  it("draws the app whole, in the sandbox, under any address that starts with the app's", async () => {
    start(sessionWith([made("m-aaaaaaaaaa", GROCERY, PERSONAL)]), `/apps/${PERSONAL}/m-aaaaaaaaaa/archive/2026`);
    expect(await screen.findByRole("heading", { level: 1, name: "Grocery list" })).toBeTruthy();
    const page = document.querySelector<HTMLElement>('[data-app-page="m-aaaaaaaaaa"]')!;
    const url = frameUrl(frameIn(page));
    expect(url.pathname).toBe(`/api/spaces/${PERSONAL}/apps/m-aaaaaaaaaa/frame`);
    expect(url.searchParams.get("view")).toBe("page");
  });

  it("is not there for an app the session does not list, has switched off, or lists without a page", async () => {
    const session = sessionWith([
      made("m-aaaaaaaaaa", GROCERY, PERSONAL, { enabled: false }),
      made("m-bbbbbbbbbb", IDEAS, PERSONAL, { hasPage: false }),
    ]);
    for (const at of [`/apps/${PERSONAL}/m-zzzzzzzzzz`, `/apps/${FAMILY}/m-aaaaaaaaaa`, `/apps/${PERSONAL}/m-aaaaaaaaaa`, `/apps/${PERSONAL}/m-bbbbbbbbbb`]) {
      start(session, at);
      expect(await screen.findByRole("heading", { level: 1, name: "Page not found" }), at).toBeTruthy();
      expect(document.querySelector("iframe"), at).toBeNull();
      cleanup();
    }
  });
});
