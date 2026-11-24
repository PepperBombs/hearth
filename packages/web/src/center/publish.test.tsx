/**
 * Publishing from an app's page (docs/center.md, step 8), drawn against a
 * stand-in for the server: who is offered "Publish…", what the dialog says
 * will leave and what refuses it, in both languages; the tick; publishing,
 * publishing again and unpublishing; and the line on a copy's page.
 */
import type { AppSummary, PublishReview, Session } from "@hearth/shared";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";

const PERSONAL = "space-personal";
const FAMILY = "space-family";
const CLUB = "space-club";

function made(id: string, spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    spaceId,
    name: { en: "Ledger", zh: "账本" },
    description: { en: "What we spend.", zh: "我们的花销。" },
    icon: "wallet",
    color: "green",
    widgetSize: "small",
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: true,
    made: true,
    version: 3,
    ...extra,
  };
}

function sessionFor(apps: AppSummary[], options: { locale?: "en" | "zh"; groups?: boolean; familyRole?: "owner" | "member" } = {}): Session {
  const me = { id: "u1", email: "sam@example.com", name: "Sam Example", locale: options.locale ?? "en", theme: "light" as const };
  const role = options.familyRole ?? "owner";
  const members = (mine: "owner" | "member") => [
    { id: me.id, name: me.name, role: mine },
    { id: "u2", name: "Lin Example", role: "member" as const },
  ];
  return {
    user: me,
    spaces: [
      { id: PERSONAL, kind: "personal", name: "", role: "owner", canAddApps: true, assistant: "none", members: [{ id: me.id, name: me.name, role: "owner" }] },
      ...(options.groups === false
        ? []
        : [
            { id: FAMILY, kind: "group" as const, name: "Family", role, canAddApps: role === "owner", assistant: "none" as const, members: members(role) },
            { id: CLUB, kind: "group" as const, name: "Book club", role: "member" as const, canAddApps: false, assistant: "none" as const, members: members("member") },
          ]),
    ],
    apps,
    canCreateGroups: false,
    canInvitePeople: false,
    version: "test",
  };
}

function review(extra: Partial<PublishReview> = {}): PublishReview {
  return {
    app: {
      name: { en: "Ledger", zh: "账本" },
      description: { en: "What we spend.", zh: "我们的花销。" },
      icon: "wallet",
      color: "green",
      collections: [{ name: "expenses", fields: ["amount", "date"] }],
      settings: {
        currency: { type: "text", label: { en: "Currency", zh: "货币" }, scope: "space", default: "EUR" },
        totals: { type: "switch", label: { en: "Show totals", zh: "显示合计" }, scope: "user", default: true },
      },
      instructions: "Keep one entry per expense.\nAmounts are in the space's currency.",
      pageBytes: 12_345,
    },
    groups: [
      { id: FAMILY, name: "Family" },
      { id: CLUB, name: "Book club" },
    ],
    listings: [],
    problems: [],
    ...extra,
  };
}

type Answer = { status: number; body?: unknown };

/** Answers the session, the review, publishing and unpublishing, and records every request with its body. */
function start(options: { session: Session; at: string; review?: PublishReview; reviewAfter?: PublishReview; publish?: Answer; unpublish?: Answer }) {
  const requests: string[] = [];
  let current = options.review ?? review();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = String(input);
    requests.push(`${method} ${path}${init.body ? ` ${String(init.body)}` : ""}`);
    if (path === "/api/session") return json(options.session);
    if (/^\/api\/spaces\/[^/]+\/apps\/[^/]+\/publish$/.test(path)) {
      if (method === "GET") return json(current);
      const answer = options.publish ?? { status: 201, body: { id: "p-ledger0001", revision: 1 } };
      if (options.reviewAfter) current = options.reviewAfter;
      return json(answer.body, answer.status);
    }
    if (/^\/api\/center\/.+$/.test(path) && method === "DELETE") {
      const answer = options.unpublish ?? { status: 204 };
      if (options.reviewAfter) current = options.reviewAfter;
      return answer.status === 204 ? new Response(null, { status: 204 }) : json(answer.body, answer.status);
    }
    if (path === "/api/center") return json({ listings: [] });
    return json({ error: { code: "not_found", message: "No such route." } }, 404);
  });
  render(
    <MemoryRouter initialEntries={[options.at]}>
      <App queryClient={new QueryClient()} />
    </MemoryRouter>,
  );
  return requests;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LEDGER = `/apps/${PERSONAL}/m-ledger0001`;

async function openDialog(name = "Publish Ledger…", title = "Publish “Ledger”") {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog", { name: title });
}

describe("Publish… on an app's page", () => {
  it("is offered to an owner of the app's space who is in a group, and to no one else", async () => {
    start({ session: sessionFor([made("m-ledger0001", PERSONAL)]), at: LEDGER });
    expect(await screen.findByRole("button", { name: "Publish Ledger…" })).toBeTruthy();
    cleanup();

    // A member of the group the app is in may not publish it.
    start({ session: sessionFor([made("m-ledger0002", FAMILY)], { familyRole: "member" }), at: `/apps/${FAMILY}/m-ledger0002` });
    expect(await screen.findByRole("heading", { level: 1, name: "Ledger" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Publish/ })).toBeNull();
    cleanup();

    // Someone in no group has nowhere to publish to.
    start({ session: sessionFor([made("m-ledger0001", PERSONAL)], { groups: false }), at: LEDGER });
    expect(await screen.findByRole("heading", { level: 1, name: "Ledger" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Publish/ })).toBeNull();
  });

  it("shows exactly what will leave, and publishes only once the tick is set", async () => {
    const requests = start({ session: sessionFor([made("m-ledger0001", PERSONAL)]), at: LEDGER });
    const dialog = await openDialog();
    const leaves = await within(dialog).findByRole("region", { name: "What will be shared" });
    expect(within(leaves).getByText("Ledger / 账本")).toBeTruthy();
    expect(within(leaves).getByText("What we spend. / 我们的花销。")).toBeTruthy();
    expect(within(leaves).getByText("expenses: amount, date")).toBeTruthy();
    expect(within(leaves).getByText("Currency: EUR")).toBeTruthy();
    expect(within(leaves).getByText("Show totals: On")).toBeTruthy();
    // The instructions in full, as they are written.
    expect(within(leaves).getByText(/Keep one entry per expense\.\s+Amounts are in the space's currency\./)).toBeTruthy();
    expect(within(leaves).getByText("About 12.3 kB")).toBeTruthy();
    expect(within(dialog).getByText(/^Never shared: its entries/)).toBeTruthy();
    expect(within(dialog).getByText("The people of the group see that you published it.")).toBeTruthy();

    // Family is chosen first; nothing goes until the tick is set.
    expect((within(dialog).getByRole("radio", { name: /Family/ }) as HTMLInputElement).checked).toBe(true);
    const publish = within(dialog).getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Book club/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "A note (optional)" }), { target: { value: "  First go  " } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have checked that this holds nothing private" }));
    expect(publish.disabled).toBe(false);
    fireEvent.click(publish);

    const done = await within(dialog).findByText("Published to Book club, revision 1.");
    await waitFor(() => expect(document.activeElement).toBe(done));
    expect(within(dialog).getByRole("link", { name: "the app center" }).getAttribute("href")).toBe("/center");
    expect(requests).toContain(`POST /api/spaces/${PERSONAL}/apps/m-ledger0001/publish {"to":"${CLUB}","note":"First go"}`);
  });

  it("words the problems that refuse it, and keeps Publish off whatever is ticked", async () => {
    start({
      session: sessionFor([made("m-ledger0001", PERSONAL)]),
      at: LEDGER,
      review: review({
        problems: [
          { code: "invalid", detail: "A collection needs at least one field." },
          { code: "network" },
          { code: "unchanged_copy" },
          { code: "email", where: { part: "page", line: 212 } },
          { code: "email", where: { part: "instructions" } },
          { code: "too_many", spaceId: CLUB },
        ],
      }),
    });
    const dialog = await openDialog();
    const problems = await within(dialog).findByRole("alert");
    expect(within(problems).getByText(/^It does not pass Hearth's checks\. Ask the chat to fix it:/)).toBeTruthy();
    expect(within(problems).getByText("A collection needs at least one field.")).toBeTruthy();
    expect(within(problems).getByText(/^It reaches other websites/)).toBeTruthy();
    expect(within(problems).getByText(/^Nobody has changed it/)).toBeTruthy();
    expect(within(problems).getByText("An email address is in the page, line 212. Ask the chat to take it out.")).toBeTruthy();
    expect(within(problems).getByText("An email address is in the instructions for the model. Ask the chat to take it out.")).toBeTruthy();
    // "too_many" closes one group, and is said there.
    const club = within(dialog).getByRole("radio", { name: /Book club/ }) as HTMLInputElement;
    expect(club.disabled).toBe(true);
    expect(within(dialog).getByText("You have 50 apps published here already. Unpublish one first.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have checked that this holds nothing private" }));
    expect((within(dialog).getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("speaks Chinese, and leaves the maker's words as they wrote them", async () => {
    start({
      session: sessionFor([made("m-ledger0001", PERSONAL)], { locale: "zh" }),
      at: LEDGER,
      review: review({ problems: [{ code: "email", where: { part: "page", line: 7 } }, { code: "unchanged_copy" }] }),
    });
    const dialog = await openDialog("发布账本…", "发布「账本」");
    const leaves = await within(dialog).findByRole("region", { name: "将要分享的内容" });
    expect(within(leaves).getByText("账本 / Ledger")).toBeTruthy();
    expect(within(leaves).getByText("货币：EUR")).toBeTruthy();
    expect(within(leaves).getByText("显示合计：开")).toBeTruthy();
    expect(within(leaves).getByText(/^Keep one entry per expense\./)).toBeTruthy();
    expect(within(dialog).getByText("页面第 7 行里有一个邮箱地址。请让对话把它删掉。")).toBeTruthy();
    expect(within(dialog).getByText(/^它还没有被修改过/)).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: "我已检查过，这里面没有隐私内容" })).toBeTruthy();
  });

  it("publishes again where it is published, and unpublishes there after asking", async () => {
    const listed = review({
      listings: [{ id: "p-ledger0001", spaceId: FAMILY, revision: 2, note: "Totals", updatedAt: "2026-11-03T10:00:00.000Z", canUnpublish: true }],
    });
    const requests = start({
      session: sessionFor([made("m-ledger0001", PERSONAL)]),
      at: LEDGER,
      review: listed,
      publish: { status: 200, body: { id: "p-ledger0001", revision: 3 } },
    });
    let dialog = await openDialog();
    const where = await within(dialog).findByRole("region", { name: "Published to" });
    expect(within(where).getByText("Revision 2: Totals · Nov 3")).toBeTruthy();
    // Not yet published to the book club, so that is chosen first; "Publish again" chooses Family.
    expect((within(dialog).getByRole("radio", { name: /Book club/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(where).getByRole("button", { name: "Publish again to Family" }));
    expect((within(dialog).getByRole("radio", { name: /Family/ }) as HTMLInputElement).checked).toBe(true);
    const note = within(dialog).getByRole("textbox", { name: "What changed (optional)" });
    expect(document.activeElement).toBe(note);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have checked that this holds nothing private" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish again" }));
    expect(await within(dialog).findByText("Published to Family, revision 3.")).toBeTruthy();
    expect(requests).toContain(`POST /api/spaces/${PERSONAL}/apps/m-ledger0001/publish {"to":"${FAMILY}"}`);

    // Unpublishing asks first, in place, then says it was done and reads the review again.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    cleanup();
    const again = start({ session: sessionFor([made("m-ledger0001", PERSONAL)]), at: LEDGER, review: listed, reviewAfter: review() });
    dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Unpublish Ledger from Family" }));
    expect(within(dialog).getByText(/Copies already added keep working, with their entries\./)).toBeTruthy();
    again.length = 0;
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish Ledger from Family" }));
    const said = await within(dialog).findByText("It is no longer published to Family. Copies of it keep working.");
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(again[0]).toBe("DELETE /api/center/p-ledger0001");
    await waitFor(() => expect(again).toContain(`GET /api/spaces/${PERSONAL}/apps/m-ledger0001/publish`));
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "Published to" })).toBeNull());
  });

  it("says why a publish was refused, and reads the review again to show it", async () => {
    const requests = start({
      session: sessionFor([made("m-ledger0001", PERSONAL)]),
      at: LEDGER,
      publish: { status: 400, body: { error: { code: "invalid_request", message: "It names hosts." } } },
      reviewAfter: review({ problems: [{ code: "network" }] }),
    });
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "I have checked that this holds nothing private" }));
    requests.length = 0;
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await within(dialog).findByText(/^It was refused: something changed since this opened\./)).toBeTruthy();
    expect(await within(dialog).findByText(/^It reaches other websites/)).toBeTruthy();
    expect(requests).toContain(`GET /api/spaces/${PERSONAL}/apps/m-ledger0001/publish`);
  });
});

describe("a copy's page", () => {
  const copy = (source: AppSummary["source"], extra: Partial<AppSummary> = {}) => made("m-copy000001", PERSONAL, { source, ...extra });
  const at = `/apps/${PERSONAL}/m-copy000001`;

  it("says who shared it, or that it is no longer shared, and offers the chat", async () => {
    start({ session: sessionFor([copy({ listingId: "p-ledger0001", by: "Lin Example" })]), at });
    expect(await screen.findByText("A copy of an app Lin Example shared")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Change it in the chat" }).getAttribute("href")).toBe(`/chat?space=${PERSONAL}&app=m-copy000001`);
    cleanup();

    start({ session: sessionFor([copy({ listingId: "p-ledger0001" })]), at });
    expect(await screen.findByText("A copy of a shared app")).toBeTruthy();
    cleanup();

    start({ session: sessionFor([copy({})]), at });
    expect(await screen.findByText("A copy of an app that is no longer shared")).toBeTruthy();
    cleanup();

    // Someone who may only look at it is not sent to change it.
    start({ session: sessionFor([copy({ listingId: "p-ledger0001", by: "Lin Example" }, { access: "view" })]), at });
    expect(await screen.findByText("A copy of an app Lin Example shared")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Change it in the chat" })).toBeNull();
    cleanup();

    // An app that is no copy says nothing of the kind.
    start({ session: sessionFor([made("m-copy000001", PERSONAL)]), at });
    expect(await screen.findByRole("heading", { level: 1, name: "Ledger" })).toBeTruthy();
    expect(screen.queryByText(/A copy of/)).toBeNull();
  });

  it("speaks Chinese", async () => {
    start({ session: sessionFor([copy({ listingId: "p-ledger0001", by: "Lin Example" })], { locale: "zh" }), at });
    expect(await screen.findByText("这是 Lin Example 分享的应用的副本")).toBeTruthy();
    expect(screen.getByRole("link", { name: "在对话里修改" })).toBeTruthy();
  });
});
