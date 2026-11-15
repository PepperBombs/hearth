/**
 * The Assistant card in Settings (docs/mini-app-contract.md, section F,
 * build step F3): the address to give Claude and what Claude may do in
 * each space. The whole web app is drawn against a stand-in for the server
 * with one person, their own space and a family.
 */
import type { MemberAccess, Session, SpaceApps, SpaceRole } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import checklistManifest from "../../../fixture-apps/checklist/manifest";
import feedManifest from "../../../fixture-apps/feed/manifest";
import { App } from "../app";
import { BundledAppsProvider, type BundledApp } from "../apps/bundled";
import { addToClaudeLink } from "./assistant-card";

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
    const path = String(input);
    const method = init.method ?? "GET";
    const body = (typeof init.body === "string" ? JSON.parse(init.body) : undefined) as Record<string, unknown> | undefined;
    if (method !== "GET") this.changes.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
    const json = (status: number, value: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const refuse = (status: number, code: string) => json(status, { error: { code, message: "Sample failure" } });
    if (this.refuse && path.endsWith(this.refuse) && method !== "GET") return refuse(409, "conflict");

    if (path === "/api/session") return json(200, this.session());
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

async function assistantCard(name = "Assistant"): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: /^(Settings|设置)$/ });
  return screen.getByRole("region", { name });
}

const spaceRow = (card: HTMLElement, spaceId: string) => within(card).getByTestId(`assistant-space-${spaceId}`);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Assistant card", () => {
  it("shows the address of this server's endpoint, and a link that opens Claude's dialog with it filled in", async () => {
    start(new FakeServer());
    const card = await assistantCard();
    expect((within(card).getByRole("textbox", { name: "Address for Claude" }) as HTMLInputElement).value).toBe(`${window.location.origin}/mcp`);
    const link = within(card).getByRole("link", { name: "Add to Claude" });
    expect(link.getAttribute("href")).toBe(addToClaudeLink(`${window.location.origin}/mcp`));
    expect(link.getAttribute("target")).toBe("_blank");
    const url = new URL(link.getAttribute("href")!);
    expect(url.origin + url.pathname).toBe("https://claude.ai/customize/connectors");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      modal: "add-custom-connector",
      connectorName: "Hearth",
      connectorUrl: `${window.location.origin}/mcp`,
    });
  });

  it("copies the address, and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    start(new FakeServer());
    const card = await assistantCard();
    fireEvent.click(within(card).getByRole("button", { name: "Copy" }));
    await within(card).findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
  });

  it("lets an owner switch a space on, and leave one of its apps out", async () => {
    const server = new FakeServer();
    start(server);
    const card = await assistantCard();
    const personal = spaceRow(card, PERSONAL);
    const levels = within(personal).getByRole("group", { name: "What Claude may do in Personal" });
    expect(within(levels).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
    // Off, no apps to choose from.
    expect(within(personal).queryByRole("checkbox")).toBeNull();

    fireEvent.click(within(levels).getByRole("button", { name: "Read and change" }));
    await waitFor(() => expect(server.levels[PERSONAL]).toBe("edit"));
    const checklist = await within(personal).findByRole("checkbox", { name: "Checklist" });
    expect((checklist as HTMLInputElement).checked).toBe(true);
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
    start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    expect(within(family).getByText("Read only")).toBeTruthy();
    expect(within(family).getByText("Set by the group's owners.")).toBeTruthy();
    expect(within(family).queryByRole("button")).toBeNull();
    expect(within(family).queryByRole("checkbox")).toBeNull();
    // The member's own space is still theirs to switch.
    expect(within(spaceRow(await assistantCard(), PERSONAL)).getByRole("group", { name: "What Claude may do in Personal" })).toBeTruthy();
  });

  it("says when a change was turned down, and shows what is saved", async () => {
    const server = new FakeServer();
    server.refuse = `/${FAMILY}/assistant`;
    start(server);
    const family = spaceRow(await assistantCard(), FAMILY);
    fireEvent.click(within(family).getByRole("button", { name: "Read only" }));
    await within(family).findByText("That change could not be saved. Try again.");
    await waitFor(() => expect(within(family).getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true"));
    expect(server.levels[FAMILY]).toBe("none");
  });

  it("speaks Chinese to someone who reads it", async () => {
    const server = new FakeServer();
    server.locale = "zh";
    server.levels[FAMILY] = "edit";
    start(server);
    const card = await assistantCard("AI 助手");
    expect(within(card).getByRole("link", { name: "添加到 Claude" })).toBeTruthy();
    const family = spaceRow(card, FAMILY);
    const levels = within(family).getByRole("group", { name: "Claude 在Family里可以做什么" });
    expect(within(levels).getAllByRole("button").map((button) => button.textContent)).toEqual(["关闭", "只读", "读写"]);
    expect(within(levels).getByRole("button", { name: "读写" }).getAttribute("aria-pressed")).toBe("true");
    expect(((await within(family).findByRole("checkbox", { name: "清单" })) as HTMLInputElement).checked).toBe(true);
  });
});
