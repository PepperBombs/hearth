/**
 * The Assistant card in Settings: what the assistant, each person's own
 * model in the chat (docs/platform.md, "The chat"), may do in each space.
 * The whole web app is drawn against a stand-in for the server with one
 * person, their own space and a family.
 */
import type { MemberAccess, Session, Space, SpaceApps, SpaceRole } from "@hearth/shared";
import { focusManager, QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import checklistManifest from "../../../fixture-apps/checklist/manifest";
import feedManifest from "../../../fixture-apps/feed/manifest";
import { App } from "../app";
import { BundledAppsProvider, type BundledApp } from "../apps/bundled";
import { SESSION_QUERY_KEY } from "../session/session";

const PERSONAL = "space-personal";
const FAMILY = "space-family";
const Empty = () => null;
const BUNDLED: readonly BundledApp[] = [
  { id: "checklist", manifest: checklistManifest, hasPage: true, widget: () => Promise.resolve({ default: Empty }) },
  { id: "feed", manifest: feedManifest, hasPage: false, widget: () => Promise.resolve({ default: Empty }) },
];

type Install = { id: string; assistant: boolean };

class FakeServer {
  locale: "en" | "zh" = "en";
  familyRole: SpaceRole = "owner";
  levels: Record<string, MemberAccess> = { [PERSONAL]: "none", [FAMILY]: "none" };
  apps: Record<string, Install[]> = {
    [PERSONAL]: [{ id: "checklist", assistant: true }],
    [FAMILY]: [
      { id: "checklist", assistant: true },
      { id: "feed", assistant: true },
    ],
  };
  changes: string[] = [];
  /** The ending of a request to turn down, with 409. */
  refuse: string | null = null;
  /** While true, nothing reaches the server: every request fails as a dropped connection does. */
  offline = false;
  /** How many times the session was read. */
  sessionReads = 0;
  /** Groups besides the family, which the person owns. */
  moreGroups: { id: string; name: string }[] = [];
  /** Set to hold a save of the person's own preferences until it is called. */
  releaseSave: (() => void) | null = null;
  holdSaves = false;

  session(): Session {
    const me = { id: "u1", name: "Sam Example", role: "owner" as const };
    return {
      user: { id: "u1", email: "sam@example.com", name: "Sam Example", locale: this.locale, theme: "light" },
      spaces: [
        { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, members: [me], assistant: this.levels[PERSONAL]! },
        {
          id: FAMILY,
          kind: "group",
          name: "Family",
          role: this.familyRole,
          canAddApps: this.familyRole === "owner",
          members: [{ ...me, role: this.familyRole }, { id: "u2", name: "Lin Example", role: this.familyRole === "owner" ? "member" : "owner" }],
          assistant: this.levels[FAMILY]!,
        },
        ...this.moreGroups.map(
          (group): Space => ({
            ...group,
            kind: "group",
            role: "owner",
            canAddApps: true,
            members: [me],
            assistant: this.levels[group.id] ?? "none",
          }),
        ),
      ],
      apps: [],
      canCreateGroups: true,
      canInvitePeople: true,
      version: "test",
    };
  }

  ownersList(spaceId: string): SpaceApps {
    return {
      apps: (this.apps[spaceId] ?? []).map((install) => ({
        ...install,
        hasCode: true,
        removedAt: null,
        rowCount: 0,
        memberAccess: "none",
        members: {},
      })),
      members: [{ id: "u1", name: "Sam Example", role: "owner", email: "sam@example.com", canAddApps: false }],
      invitations: [],
    };
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const path = String(input);
    const method = init.method ?? "GET";
    const body = (typeof init.body === "string" ? JSON.parse(init.body) : undefined) as Record<string, unknown> | undefined;
    if (method !== "GET") this.changes.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    const json = (status: number, value: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const refuse = (status: number, code: string) => json(status, { error: { code, message: "Sample failure" } });
    if (this.refuse && path.endsWith(this.refuse) && method !== "GET") return refuse(409, "conflict");

    if (path === "/api/session") {
      this.sessionReads += 1;
      return json(200, this.session());
    }
    if (path === "/api/me" && method === "PATCH") {
      if (this.holdSaves) await new Promise<void>((resolve) => (this.releaseSave = resolve));
      if (body?.locale === "en" || body?.locale === "zh") this.locale = body.locale;
      return json(204, null);
    }
    const match = /^\/api\/spaces\/([^/]+)\/(.+)$/.exec(path);
    const spaceId = match?.[1] ?? "";
    const rest = match?.[2] ?? "";
    const owner = spaceId === PERSONAL || this.familyRole === "owner";
    if (!(spaceId in this.levels)) return refuse(404, "not_found");
    if (rest === "apps" && method === "GET") return owner ? json(200, this.ownersList(spaceId)) : refuse(403, "forbidden");
    if (rest === "assistant" && method === "PUT") {
      if (!owner) return refuse(403, "forbidden");
      this.levels[spaceId] = body?.level as MemberAccess;
      return json(204, null);
    }
    const access = /^apps\/([^/]+)\/access$/.exec(rest);
    const install = this.apps[spaceId]?.find((candidate) => candidate.id === access?.[1]);
    if (access && method === "PUT") {
      if (!install) return refuse(404, "not_found");
      if (!owner) return refuse(403, "forbidden");
      if (typeof body?.assistant === "boolean") install.assistant = body.assistant;
      return json(204, null);
    }
    return refuse(404, "not_found");
  };
}

function start(server: FakeServer): QueryClient {
  vi.stubGlobal("fetch", server.fetch);
  const client = new QueryClient();
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <BundledAppsProvider apps={BUNDLED}>
        <App queryClient={client} />
      </BundledAppsProvider>
    </MemoryRouter>,
  );
  return client;
}

/** Lets the session the page holds count as read a minute ago, as on a page that has been open for a while. */
function ageSession(client: QueryClient): void {
  client.setQueryData(SESSION_QUERY_KEY, client.getQueryData(SESSION_QUERY_KEY), { updatedAt: Date.now() - 60_000 });
}

/** The window is looked away from and at again. */
function lookAgain(): void {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

const pressed = (row: HTMLElement) =>
  within(row)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent);

async function assistantCard(name = "Assistant"): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: /^(Settings|设置)$/ });
  return screen.getByRole("region", { name });
}

const spaceRow = (card: HTMLElement, spaceId: string) => within(card).getByTestId(`assistant-space-${spaceId}`);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
});

describe("the Assistant card", () => {
  it("says what the assistant is, and links to the chat, with nothing else to follow or copy", async () => {
    start(new FakeServer());
    const card = await assistantCard();
    const chat = within(card).getByRole("link", { name: "the chat" });
    expect(chat.getAttribute("href")).toBe("/chat");
    expect(chat.closest("p")!.textContent).toBe(
      "The assistant is your own model, which you save under “Your model” and talk to in the chat. It acts as you, with your access, and only in the spaces below that allow it.",
    );
    // The assistant lives in Hearth: there is no address to copy, and no link out of it.
    expect(within(card).getAllByRole("link")).toEqual([chat]);
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.click(chat);
    await screen.findByRole("heading", { level: 1, name: "Chat" });
  });

  it("lets an owner switch a space on, and leave one of its apps out", async () => {
    const server = new FakeServer();
    start(server);
    const card = await assistantCard();
    const personal = spaceRow(card, PERSONAL);
    const levels = within(personal).getByRole("group", { name: "What the assistant may do in your personal space" });
    expect(within(levels).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
    // Off, no apps to choose from.
    expect(within(personal).queryByRole("checkbox")).toBeNull();

    fireEvent.click(within(levels).getByRole("button", { name: "Read and change" }));
    await waitFor(() => expect(server.levels[PERSONAL]).toBe("edit"));
    const checklist = await within(personal).findByRole("checkbox", { name: "Checklist" });
    expect((checklist as HTMLInputElement).checked).toBe(true);
    expect(within(personal).getByRole("group", { name: "Apps the assistant may use in your personal space" })).toBeTruthy();
    expect(within(levels).getByRole("button", { name: "Read and change" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(checklist);
    await waitFor(() => expect(server.apps[PERSONAL]![0]!.assistant).toBe(false));
    await waitFor(() => expect((within(personal).getByRole("checkbox", { name: "Checklist" }) as HTMLInputElement).checked).toBe(false));
    expect(server.changes).toEqual([
      `PUT /api/spaces/${PERSONAL}/assistant {"level":"edit"}`,
      `PUT /api/spaces/${PERSONAL}/apps/checklist/access {"assistant":false}`,
    ]);
  });

  it("shows a member what the group's owners chose, with nothing to change", async () => {
    const server = new FakeServer();
    server.familyRole = "member";
    server.levels[FAMILY] = "view";
    const client = start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    expect(within(family).getByText("Read only")).toBeTruthy();
    expect(within(family).getByText("Set by the group's owners.")).toBeTruthy();
    expect(within(family).queryByRole("button")).toBeNull();
    expect(within(family).queryByRole("checkbox")).toBeNull();
    // An owner switches the group off: the member's page says so the next time it is looked at.
    server.levels[FAMILY] = "none";
    ageSession(client);
    lookAgain();
    await within(family).findByText("Off");
    expect(within(family).queryByText("Read only")).toBeNull();
    // The member's own space is still theirs to switch.
    expect(
      within(spaceRow(await assistantCard(), PERSONAL)).getByRole("group", { name: "What the assistant may do in your personal space" }),
    ).toBeTruthy();
  });

  it("says when a change was turned down, and shows what is saved", async () => {
    const server = new FakeServer();
    server.refuse = `/${FAMILY}/assistant`;
    start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    // Where the failure will be said is on the page first: a screen reader announces what comes into it.
    const said = within(family).getAllByRole("status");
    expect(said.map((region) => region.textContent)).toEqual([""]);
    fireEvent.click(within(family).getByRole("button", { name: "Read only" }));
    await within(family).findByText("That change could not be saved. Try again.");
    expect(said[0]!.textContent).toBe("That change could not be saved. Try again.");
    await waitFor(() => expect(within(family).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true"));
    expect(server.levels[FAMILY]).toBe("none");
  });

  it("shows the level that is saved now, not the one the page loaded: another owner may have changed it since", async () => {
    const server = new FakeServer();
    const client = start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    expect(pressed(family)).toEqual(["Off"]);
    // Opened straight after loading, Settings reads the session once.
    expect(server.sessionReads).toBe(1);

    // Lin, who owns the family too, lets the assistant change things there. This page has been open for a while.
    server.levels[FAMILY] = "edit";
    ageSession(client);
    lookAgain();
    await waitFor(() => expect(pressed(family)).toEqual(["Read and change"]));
    expect((await within(family).findByRole("checkbox", { name: "Checklist" }) as HTMLInputElement).checked).toBe(true);

    // And coming back to Settings from another page reads it again too.
    server.levels[FAMILY] = "view";
    fireEvent.click(screen.getAllByRole("link", { name: "Dashboard" })[0]!);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    ageSession(client);
    fireEvent.click(screen.getAllByRole("link", { name: "Settings" })[0]!);
    const again = spaceRow(await assistantCard(), FAMILY);
    await waitFor(() => expect(pressed(again)).toEqual(["Read only"]));
    // Nothing was changed from here.
    expect(server.changes).toEqual([]);
  });

  it("does not put an old language back when the session is read again while a new one is being saved", async () => {
    const server = new FakeServer();
    server.holdSaves = true;
    const client = start(server);
    await assistantCard();
    // The person chooses Chinese; the save is on its way and the server still has English.
    fireEvent.click(screen.getAllByRole("button", { name: /Switch language/ })[0]!);
    await assistantCard("AI 助手");
    await waitFor(() => expect(server.releaseSave).not.toBeNull());
    // The window is looked at again meanwhile: the session comes back as the server still has it.
    const reads = server.sessionReads;
    ageSession(client);
    lookAgain();
    await waitFor(() => expect(server.sessionReads).toBe(reads + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("region", { name: "AI 助手" })).toBeTruthy();
    // Once it is saved, the session is read anew and says the same.
    server.releaseSave!();
    await waitFor(() => expect(server.sessionReads).toBe(reads + 2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("region", { name: "AI 助手" })).toBeTruthy();
    expect(server.locale).toBe("zh");
  });

  it("keeps the apps on the page when a choice could not be sent, and says that it was not saved", async () => {
    const server = new FakeServer();
    server.levels[FAMILY] = "edit";
    start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    const checklist = (await within(family).findByRole("checkbox", { name: "Checklist" })) as HTMLInputElement;
    checklist.focus();
    server.offline = true;
    fireEvent.click(checklist);
    await within(family).findByText("That change could not be saved. Try again.", undefined, { timeout: 5000 });
    // The list could not be read again either: the boxes stay as they were saved, and so does the focus.
    await waitFor(() => expect((within(family).getByRole("checkbox", { name: "Checklist" }) as HTMLInputElement).checked).toBe(true), {
      timeout: 5000,
    });
    expect(within(family).queryByText("The apps could not be loaded.")).toBeNull();
    expect(document.activeElement).toBe(within(family).getByRole("checkbox", { name: "Checklist" }));
    expect(server.apps[FAMILY]![0]!.assistant).toBe(true);
  }, 20_000);

  it("offers to try again when the apps could not be read at all", async () => {
    const server = new FakeServer();
    server.levels[FAMILY] = "edit";
    server.refuse = null;
    const original = server.fetch;
    let failing = true;
    server.fetch = async (input, init) => {
      if (failing && String(input) === `/api/spaces/${FAMILY}/apps`) return new Response("{}", { status: 500 });
      return original(input, init);
    };
    start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    await within(family).findByText("The apps could not be loaded.", undefined, { timeout: 5000 });
    failing = false;
    fireEvent.click(within(family).getByRole("button", { name: "Try again" }));
    expect(((await within(family).findByRole("checkbox", { name: "Checklist" })) as HTMLInputElement).checked).toBe(true);
  });

  it("lets a long name without a space break anywhere, so that it fits a phone", async () => {
    const server = new FakeServer();
    server.moreGroups = [{ id: "space-hikers", name: "TheExampleFamilyOfTheNorthernHillsAndValleysWhoWalkEveryWeekend" }];
    start(server);
    const hikers = spaceRow(await assistantCard(), "space-hikers");
    expect(within(hikers).getByText("TheExampleFamilyOfTheNorthernHillsAndValleysWhoWalkEveryWeekend").className).toContain("wrap-anywhere");
  });

  it("speaks Chinese to someone who reads it", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    server.levels[FAMILY] = "edit";
    server.levels[PERSONAL] = "view";
    start(server);
    const card = await assistantCard("AI 助手");
    const personal = spaceRow(card, PERSONAL);
    expect(within(personal).getByText("个人")).toBeTruthy();
    // The person's own space is spoken of as theirs, not put into the sentence as a name.
    expect(within(personal).getByRole("group", { name: "AI 助手在你的个人空间里可以做什么" })).toBeTruthy();
    expect(await within(personal).findByRole("group", { name: "AI 助手在你的个人空间里可以使用的应用" })).toBeTruthy();
    const chat = within(card).getByRole("link", { name: "对话" });
    expect(chat.getAttribute("href")).toBe("/chat");
    expect(chat.closest("p")!.textContent).toBe(
      "AI 助手就是你自己的模型：你在“你的模型”里保存它，在对话里和它交谈。它以你的身份、按你的权限办事，而且只在下面允许它的空间里。",
    );
    const family = spaceRow(card, FAMILY);
    const levels = within(family).getByRole("group", { name: "AI 助手在Family里可以做什么" });
    expect(within(levels).getAllByRole("button").map((button) => button.textContent)).toEqual(["关闭", "只读", "读写"]);
    expect(within(levels).getByRole("button", { name: "读写" }).getAttribute("aria-pressed")).toBe("true");
    expect(((await within(family).findByRole("checkbox", { name: "清单" })) as HTMLInputElement).checked).toBe(true);
  });
});
