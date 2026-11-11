/**
 * Shared set-up for the end-to-end tests.
 *
 * `api` stands in for the server: it answers GET /api/session and
 * PATCH /api/me from memory, checks both against the shared contract, and
 * remembers what was saved, so a reload sees it. It also answers for the
 * framework's two sample apps (packages/fixture-apps), which the tested
 * build holds: the checklist's routes, from a list kept here, both apps'
 * settings, adding either to a space, removing an app, moving one to
 * another space, and each person's switch and pin. And it keeps groups:
 * creating one, renaming it, adding,
 * changing and removing people, invitations, the owners' list of a group
 * and who can use each app (`groups`, `people`). All names and addresses
 * are made up.
 */
import { expect, test as base, type Page, type Route } from "@playwright/test";
import {
  addAppRequestSchema,
  addMemberRequestSchema,
  appAccessRequestSchema,
  appCallRequestSchema,
  appCallResponseSchema,
  appPrefsPatchSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  createSpaceRequestSchema,
  memberPatchSchema,
  moveAppRequestSchema,
  preferencesPatchSchema,
  sessionSchema,
  spaceAppsSchema,
  spacePatchSchema,
  withdrawInvitationRequestSchema,
  type ApiErrorCode,
  type AppSettings,
  type AppSummary,
  type PreferencesPatch,
  type Session,
  type SpaceApps,
  type SpaceMember,
} from "../packages/shared/src/index.ts";

export const PERSONAL_SPACE = "space-personal";
export const FAMILY_SPACE = "space-family";

/** A member whose Hearth has no apps yet: what the shell looks like today. */
export function emptySession(overrides: Partial<Session["user"]> = {}): Session {
  const user: Session["user"] = {
    id: "user-1",
    email: "sam@example.com",
    name: "Sam Example",
    locale: "en",
    theme: "light",
    ...overrides,
  };
  return {
    user,
    spaces: [
      {
        id: PERSONAL_SPACE,
        kind: "personal",
        name: "",
        role: "owner",
        canAddApps: true,
        members: [{ id: user.id, name: user.name, role: "owner" }],
      },
    ],
    apps: [],
    canCreateGroups: false,
    canInvitePeople: false,
    version: "a1b2c3d",
  };
}

function app(
  id: string,
  spaceId: string,
  en: string,
  zh: string,
  enDescription: string,
  zhDescription: string,
  icon: string,
  color: string,
  extra: Partial<AppSummary> = {},
): AppSummary {
  return {
    id,
    spaceId,
    name: { en, zh },
    description: { en: enDescription, zh: zhDescription },
    icon,
    color,
    widgetSize: "small",
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: true,
    ...extra,
  };
}

/**
 * A member with a family space and a few apps, to exercise the shell's own
 * lists: sidebar, dashboard grid, app list, quick switcher. The tested build
 * holds none of these apps, so each card and page says "Reload to update";
 * `sessionWithSampleApps` lists the ones it does hold.
 */
export function sessionWithApps(overrides: Partial<Session["user"]> = {}): Session {
  const session = emptySession(overrides);
  return {
    ...session,
    spaces: [
      ...session.spaces,
      {
        id: FAMILY_SPACE,
        kind: "group",
        name: "Family",
        role: "owner",
        canAddApps: true,
        members: [
          { id: session.user.id, name: session.user.name, role: "owner" },
          { id: "user-2", name: "Lin Example", role: "member" },
        ],
      },
    ],
    apps: [
      app("grocery", FAMILY_SPACE, "Grocery", "购物清单", "Shared shopping list", "全家共用的购物清单", "shopping-bag", "green", {
        pinned: true,
      }),
      app("trending", PERSONAL_SPACE, "GitHub Trending", "GitHub 趋势", "Trending repositories, refreshed hourly", "热门仓库，每小时刷新", "trending-up", "purple"),
      app("stocks", PERSONAL_SPACE, "Stocks", "股票", "Daily changes for your watchlist", "自选股的每日涨跌", "chart-column", "teal"),
      app("notes", PERSONAL_SPACE, "Notes", "笔记", "Markdown notes with live preview", "支持实时预览的 Markdown 笔记", "file-text", "amber"),
      app("finance", PERSONAL_SPACE, "Finance", "财务", "Spending by month, CSV import", "按月查看支出，支持导入 CSV", "credit-card", "pink", {
        enabled: false,
      }),
    ],
  };
}

/**
 * A member whose spaces hold the two apps this build really carries: the
 * checklist in the family space and the feed in their own. Their widgets
 * and the checklist's page are drawn from the apps' own code.
 */
export function sessionWithSampleApps(overrides: Partial<Session["user"]> = {}, checklist: Partial<AppSummary> = {}): Session {
  const session = sessionWithApps(overrides);
  return {
    ...session,
    apps: [sampleApp("checklist", FAMILY_SPACE, checklist), sampleApp("feed", PERSONAL_SPACE)],
  };
}

/** One of the two apps this build holds, in a space, as the session lists it. */
export function sampleApp(id: "checklist" | "feed", spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  if (id === "checklist") {
    return app("checklist", spaceId, "Checklist", "清单", "A list of things to do, ticked off as you go.", "一份待办清单，完成一项勾选一项。", "list-checks", "teal", {
      widgetSize: "tall",
      ...extra,
    });
  }
  return app("feed", spaceId, "Feed", "动态", "A sample card that each person filters for themselves.", "每个人可以自行筛选的示例卡片。", "trending-up", "purple", {
    widgetSize: "wide",
    hasPage: false,
    ...extra,
  });
}

/** One item of the sample checklist, as its `list` query answers. */
export type ChecklistItem = {
  id: string;
  name: string;
  section: string;
  done: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

function item(id: string, name: string, done = false, section = ""): ChecklistItem {
  const at = "2026-11-10T08:00:00.000Z";
  return { id, name, section, done, createdBy: "user-1", updatedBy: "user-1", createdAt: at, updatedAt: at };
}

type Failure = { status: number; code: ApiErrorCode; message: string };

/** Someone the stand-in server knows by address: adding them to a group adds them at once. */
export type KnownPerson = { id: string; name: string; email: string };

export class FakeApi {
  /** What GET /api/session returns. Checked against the contract when set. */
  private current: Session = sessionSchema.parse(emptySession());
  private sessionFailure: Failure | null = null;
  /** Make PATCH /api/me fail with a server error. */
  failSaves = false;
  /** Every body accepted by PATCH /api/me, in order. */
  readonly saved: PreferencesPatch[] = [];
  sessionRequests = 0;

  /** What the sample checklist holds, wherever it is. Change it to stand in for someone else's change. */
  items: ChecklistItem[] = [item("item-1", "Water the plants"), item("item-2", "Book the dentist"), item("item-3", "Return the library books", true)];
  /** The sample apps' settings, by app ID. */
  appSettings: Record<string, AppSettings> = {
    checklist: { space: { sections: [] }, user: { hideDone: false } },
    feed: { space: {}, user: { topics: [], period: "day" } },
  };
  /** Make every route of every app fail, for example `{ status: 500, code: "internal", message: "Sample failure" }`. */
  appFailure: Failure | null = null;
  /** Every request made for an app, as "METHOD path", in order. */
  readonly appRequests: string[] = [];
  /** Every change asked of the routes for apps in a space (add, remove, move, switch and pin, settings), as "METHOD path body". */
  readonly appChanges: string[] = [];
  /**
   * The owners' list of each group the session's person owns, by space ID,
   * and the people on the server besides them. Groups and their members are
   * the session's; this holds what only owners see.
   */
  groups: Record<string, SpaceApps> = {};
  people: KnownPerson[] = [];
  /** Every change asked of the routes for groups and access, as "METHOD path body". */
  readonly groupChanges: string[] = [];
  private held: Promise<void> | null = null;

  /** Keeps the answers to requests for apps back until the returned function is called. */
  holdApps(): () => void {
    let release = () => {};
    this.held = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      this.held = null;
      release();
    };
  }

  /** How many requests for apps ended like this, for example "/q/list". */
  appRequestCount(ending: string): number {
    return this.appRequests.filter((request) => request.endsWith(ending)).length;
  }

  get session(): Session {
    return this.current;
  }

  setSession(session: Session): void {
    this.current = sessionSchema.parse(session);
    this.sessionFailure = null;
  }

  /** Make GET /api/session fail, for example `failSession(403, "not_a_member")`. */
  failSession(status: number, code: ApiErrorCode, message = "Sample failure"): void {
    this.sessionFailure = { status, code, message };
  }

  async install(page: Page): Promise<void> {
    await page.route("**/api/**", (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const fail = (failure: Failure) =>
      route.fulfill({ status: failure.status, json: { error: { code: failure.code, message: failure.message } } });

    if (path === "/api/session" && request.method() === "GET") {
      this.sessionRequests += 1;
      if (this.sessionFailure) return fail(this.sessionFailure);
      return route.fulfill({ json: this.current });
    }

    if (path === "/api/me" && request.method() === "PATCH") {
      if (this.failSaves) return fail({ status: 500, code: "internal", message: "Sample failure" });
      const parsed = preferencesPatchSchema.safeParse(request.postDataJSON());
      if (!parsed.success) return fail({ status: 400, code: "invalid_request", message: "Sample failure" });
      this.saved.push(parsed.data);
      this.current = { ...this.current, user: { ...this.current.user, ...parsed.data } };
      return route.fulfill({ json: this.current.user });
    }

    const forGroups = this.answerForGroups(path, request.method(), request.postDataJSON() as unknown);
    if (forGroups) {
      if ("status" in forGroups) return fail(forGroups);
      return forGroups.json === undefined ? route.fulfill({ status: 204 }) : route.fulfill({ status: forGroups.created ? 201 : 200, json: forGroups.json });
    }

    const install = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)$/.exec(path);
    if (install) {
      const [, spaceId = "", appId = ""] = install;
      const method = request.method();
      const body: unknown = request.postDataJSON();
      this.appChanges.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
      if (this.appFailure) return fail(this.appFailure);
      const space = this.current.spaces.find((candidate) => candidate.id === spaceId);
      const listed = this.current.apps.find((candidate) => candidate.spaceId === spaceId && candidate.id === appId);
      // The owners' list of a group follows: an app added there is in it, a removed one is marked so.
      const owners = this.groups[spaceId];
      if (method === "PUT") {
        const parsed = addAppRequestSchema.safeParse(body);
        if (!parsed.success) return fail({ status: 400, code: "invalid_request", message: "Sample failure" });
        if (!space || (appId !== "checklist" && appId !== "feed")) return fail({ status: 404, code: "not_found", message: "No such app" });
        if (!space.canAddApps) return fail({ status: 403, code: "forbidden", message: "Sample failure" });
        if (!listed) this.setSession({ ...this.current, apps: [...this.current.apps, sampleApp(appId, spaceId)] });
        if (owners && !owners.apps.some((entry) => entry.id === appId)) {
          owners.apps.push({ id: appId, hasCode: true, removedAt: null, rowCount: 0, memberAccess: parsed.data.memberAccess ?? "none", members: {} });
        }
        return route.fulfill({ status: 204 });
      }
      if (method === "DELETE" && listed) {
        if (space?.role !== "owner") return fail({ status: 403, code: "forbidden", message: "Sample failure" });
        this.setSession({ ...this.current, apps: this.current.apps.filter((candidate) => candidate !== listed) });
        for (const entry of owners?.apps ?? []) if (entry.id === appId) entry.removedAt = "2026-11-10T08:00:00.000Z";
        return route.fulfill({ status: 204 });
      }
      return fail({ status: 404, code: "not_found", message: "No such app" });
    }

    const forApp = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)\/(.+)$/.exec(path);
    if (forApp) {
      this.appRequests.push(`${request.method()} ${path}`);
      if (this.held) await this.held;
      if (this.appFailure) return fail(this.appFailure);
      const [, spaceId = "", appId = "", rest = ""] = forApp;
      // As on the server: an app the session does not list is not there at all.
      const listed = this.current.apps.find((candidate) => candidate.spaceId === spaceId && candidate.id === appId);
      if (listed && rest === "me" && request.method() === "PATCH") {
        const patch = appPrefsPatchSchema.safeParse(request.postDataJSON());
        if (!patch.success) return fail({ status: 400, code: "invalid_request", message: "Sample failure" });
        this.appChanges.push(`PATCH ${path} ${JSON.stringify(patch.data)}`);
        this.setSession({ ...this.current, apps: this.current.apps.map((candidate) => (candidate === listed ? { ...candidate, ...patch.data } : candidate)) });
        return route.fulfill({ status: 204 });
      }
      if (listed && rest === "move" && request.method() === "POST") {
        const move = this.moveApp(listed, request.postDataJSON() as unknown);
        this.appChanges.push(`POST ${path} ${JSON.stringify(request.postDataJSON() ?? null)}`);
        return move ? fail(move) : route.fulfill({ status: 204 });
      }
      // As on the server: the space's settings need edit access, the person's own only view.
      const body: unknown = request.postDataJSON();
      if (listed?.access === "view" && rest === "settings" && request.method() === "PATCH" && (body as { space?: unknown } | null)?.space) {
        return fail({ status: 403, code: "forbidden", message: "Sample failure" });
      }
      const answer = listed ? this.answerForApp(appId, rest, request.method(), body) : undefined;
      if (answer === undefined) return fail({ status: 404, code: "not_found", message: "No such app or route" });
      if ("status" in answer) return fail(answer);
      return route.fulfill({ json: answer.json });
    }

    return fail({ status: 404, code: "not_found", message: "No such route" });
  }

  /**
   * What the routes for groups and access answer, as the server would for
   * the session's person; undefined for any other address. Requests are
   * checked against the shared contract, and so is the owners' list.
   */
  private answerForGroups(path: string, method: string, body: unknown): { json?: unknown; created?: boolean } | Failure | undefined {
    const refuse = (status: number, code: ApiErrorCode): Failure => ({ status, code, message: "Sample failure" });
    const me = this.current.user;
    const record = () => this.groupChanges.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);

    if (path === "/api/spaces" && method === "POST") {
      record();
      const parsed = createSpaceRequestSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_request");
      if (!this.current.canCreateGroups) return refuse(403, "forbidden");
      const space = {
        id: `space-${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${this.current.spaces.length}`,
        kind: "group" as const,
        name: parsed.data.name,
        role: "owner" as const,
        canAddApps: true,
        members: [{ id: me.id, name: me.name, role: "owner" as const }],
      };
      this.setSession({ ...this.current, spaces: [...this.current.spaces, space] });
      this.groups[space.id] = { apps: [], members: [{ ...space.members[0]!, email: me.email, canAddApps: false }], invitations: [] };
      return { json: space, created: true };
    }

    const match = /^\/api\/spaces\/([^/]+)(?:\/(members|invitations|apps)(?:\/([^/]+)(?:\/(access))?)?)?$/.exec(path);
    if (!match) return undefined;
    const [, spaceId = "", part, id, access] = match;
    if (part === "apps" && id && !access) return undefined;
    if (part === "apps" && !id && method !== "GET") return undefined;
    if (method !== "GET") record();
    const space = this.current.spaces.find((candidate) => candidate.id === spaceId);
    const details = this.groups[spaceId];
    if (!space || space.kind !== "group") return refuse(404, "not_found");
    const owner = space.role === "owner";
    const changeSpace = (change: (members: SpaceMember[]) => SpaceMember[], name = space.name) => {
      const members = change(space.members);
      const stillIn = members.some((member) => member.id === me.id);
      this.setSession({
        ...this.current,
        spaces: stillIn
          ? this.current.spaces.map((candidate) =>
              candidate.id === spaceId ? { ...candidate, name, members, role: members.find((member) => member.id === me.id)!.role } : candidate,
            )
          : this.current.spaces.filter((candidate) => candidate.id !== spaceId),
        apps: stillIn ? this.current.apps : this.current.apps.filter((app) => app.spaceId !== spaceId),
      });
    };

    if (!part && method === "PATCH") {
      const parsed = spacePatchSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_request");
      if (!owner) return refuse(403, "forbidden");
      changeSpace((members) => members, parsed.data.name ?? space.name);
      return {};
    }
    if (part === "apps" && method === "GET") {
      if (!owner || !details) return refuse(403, "forbidden");
      return { json: spaceAppsSchema.parse(details) };
    }
    if (!owner && !(part === "members" && method === "DELETE" && id === me.id)) return refuse(403, "forbidden");
    if (!details) return refuse(404, "not_found");
    if (part === "members" && !id && method === "POST") {
      const parsed = addMemberRequestSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_request");
      const email = parsed.data.email.toLowerCase();
      if (!email.includes("@")) return refuse(400, "invalid_request");
      const role = parsed.data.role ?? "member";
      const canAddApps = parsed.data.canAddApps === true;
      const known = this.people.find((person) => person.email === email);
      if (known) {
        if (space.members.some((member) => member.id === known.id)) return refuse(409, "conflict");
        changeSpace((members) => [...members, { id: known.id, name: known.name, role }]);
        details.members.push({ ...known, role, canAddApps });
        return { json: { outcome: "added" } };
      }
      if (!this.current.canInvitePeople) return refuse(403, "forbidden");
      if (details.invitations.some((invitation) => invitation.email === email)) return refuse(409, "conflict");
      details.invitations.push({ email, role, canAddApps });
      return { json: { outcome: "invited" } };
    }
    if (part === "invitations" && !id && method === "DELETE") {
      const parsed = withdrawInvitationRequestSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_request");
      const before = details.invitations.length;
      details.invitations = details.invitations.filter((invitation) => invitation.email !== parsed.data.email);
      return details.invitations.length === before ? refuse(404, "not_found") : {};
    }
    // Who is in the group is the session's; the owners' list follows it.
    const target = space.members.find((member) => member.id === id);
    const lastOwner = target?.role === "owner" && space.members.filter((member) => member.role === "owner").length === 1;
    if (part === "members" && id && method === "PATCH") {
      const parsed = memberPatchSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_request");
      if (!target) return refuse(404, "not_found");
      if (lastOwner && parsed.data.role === "member") return refuse(409, "conflict");
      const role = parsed.data.role ?? target.role;
      for (const member of details.members) if (member.id === target.id) Object.assign(member, parsed.data);
      changeSpace((members) => members.map((member) => (member.id === target.id ? { ...member, role } : member)));
      return {};
    }
    if (part === "members" && id && method === "DELETE") {
      if (!target) return refuse(404, "not_found");
      if (lastOwner) return refuse(409, "conflict");
      details.members = details.members.filter((member) => member.id !== target.id);
      changeSpace((members) => members.filter((member) => member.id !== target.id));
      return {};
    }
    if (part === "apps" && id && access && method === "PUT") {
      const parsed = appAccessRequestSchema.safeParse(body);
      if (!parsed.success) return refuse(400, "invalid_request");
      const app = details.apps.find((candidate) => candidate.id === id);
      if (!app) return refuse(404, "not_found");
      if (parsed.data.memberAccess) app.memberAccess = parsed.data.memberAccess;
      for (const [memberId, level] of Object.entries(parsed.data.members ?? {})) {
        if (level === null) delete app.members[memberId];
        else app.members[memberId] = level;
      }
      return {};
    }
    return refuse(404, "not_found");
  }

  /**
   * Moves an app the session lists to another of the person's spaces, as
   * the server would: they must own the space it is in and may add apps to
   * the other, which must not have it. Access there starts afresh, and the
   * owners' lists of both spaces follow. Answers the refusal, or nothing
   * once the app is moved.
   */
  private moveApp(listed: AppSummary, body: unknown): Failure | undefined {
    const refuse = (status: number, code: ApiErrorCode): Failure => ({ status, code, message: "Sample failure" });
    const parsed = moveAppRequestSchema.safeParse(body);
    if (!parsed.success) return refuse(400, "invalid_request");
    const from = this.current.spaces.find((space) => space.id === listed.spaceId);
    if (from?.role !== "owner") return refuse(403, "forbidden");
    const to = this.current.spaces.find((space) => space.id === parsed.data.toSpaceId);
    if (!to) return refuse(404, "not_found");
    if (!to.canAddApps) return refuse(403, "forbidden");
    const target = this.groups[to.id];
    if (this.current.apps.some((app) => app.spaceId === to.id && app.id === listed.id) || target?.apps.some((entry) => entry.id === listed.id)) {
      return refuse(409, "conflict");
    }
    const source = this.groups[from.id];
    const entry = source?.apps.find((candidate) => candidate.id === listed.id);
    if (source) source.apps = source.apps.filter((candidate) => candidate !== entry);
    target?.apps.push({
      id: listed.id,
      hasCode: true,
      removedAt: null,
      rowCount: entry?.rowCount ?? 0,
      memberAccess: parsed.data.memberAccess ?? "none",
      // Someone who is not an owner there keeps edit for themselves, as when they add an app.
      members: to.role === "owner" ? {} : { [this.current.user.id]: "edit" },
    });
    // The mover can always use it where it went: as an owner, or by that exception.
    this.setSession({ ...this.current, apps: this.current.apps.map((app) => (app === listed ? { ...app, spaceId: to.id, access: "edit" } : app)) });
    return undefined;
  }

  /** What the sample apps answer, checked against the shared contract. Undefined: nothing at this address. */
  private answerForApp(appId: string, rest: string, method: string, body: unknown): { json: unknown } | Failure | undefined {
    const settings = this.appSettings[appId];
    if (rest === "settings" && method === "GET" && settings) return { json: appSettingsSchema.parse(settings) };
    if (rest === "settings" && method === "PATCH" && settings) {
      const patch = appSettingsPatchSchema.safeParse(body);
      if (!patch.success) return { status: 400, code: "invalid_request", message: "Sample failure" };
      this.appChanges.push(`PATCH ${appId}/settings ${JSON.stringify(patch.data)}`);
      const updated = { space: { ...settings.space, ...patch.data.space }, user: { ...settings.user, ...patch.data.user } };
      this.appSettings[appId] = updated;
      return { json: appSettingsSchema.parse(updated) };
    }
    if (appId !== "checklist" || method !== "POST") return undefined;

    const envelope = appCallRequestSchema.safeParse(body);
    if (!envelope.success) return { status: 400, code: "invalid_request", message: "Sample failure" };
    const input = (envelope.data.input ?? {}) as { id?: string; name?: string; section?: string; done?: boolean };
    const output = (value: unknown) => ({ json: appCallResponseSchema.parse({ output: value }) });

    if (rest === "q/list") return output(this.items);
    if (rest === "m/tick") {
      const found = this.items.find((candidate) => candidate.id === input.id);
      if (!found) return { status: 404, code: "not_found", message: "No such item" };
      found.done = input.done === true;
      return output(found);
    }
    if (rest === "m/add") {
      const added = item(`item-${this.items.length + 1}-${Date.now()}`, String(input.name ?? "").trim(), false, input.section ?? "");
      if (added.name === "") return { status: 400, code: "invalid_request", message: "Sample failure" };
      this.items.push(added);
      return output(added);
    }
    if (rest === "m/clearTicked") {
      const before = this.items.length;
      this.items = this.items.filter((candidate) => !candidate.done);
      return output(before - this.items.length);
    }
    return undefined;
  }
}

/** Two people on the stand-in server besides the signed-in one: the family's other members. */
export const LIN: KnownPerson = { id: "user-2", name: "Lin Example", email: "lin@example.com" };
export const KIM: KnownPerson = { id: "user-3", name: "Kim Example", email: "kim@example.com" };

/**
 * The signed-in person as the server's owner, who owns the family: Lin is a
 * member, Kim a member who may add apps, and Pat is invited and has not
 * arrived. The family has the checklist, which every member may view and
 * Kim may change.
 */
export function ownAFamily(api: FakeApi, user: Partial<Session["user"]> = {}): void {
  const session = emptySession(user);
  const me = { id: session.user.id, name: session.user.name, email: session.user.email };
  api.people = [LIN, KIM];
  api.setSession({
    ...session,
    canCreateGroups: true,
    canInvitePeople: true,
    spaces: [
      ...session.spaces,
      {
        id: FAMILY_SPACE,
        kind: "group",
        name: "Family",
        role: "owner",
        canAddApps: true,
        members: [
          { id: me.id, name: me.name, role: "owner" },
          { id: LIN.id, name: LIN.name, role: "member" },
          { id: KIM.id, name: KIM.name, role: "member" },
        ],
      },
    ],
    apps: [sampleApp("checklist", FAMILY_SPACE)],
  });
  api.groups[FAMILY_SPACE] = {
    apps: [{ id: "checklist", hasCode: true, removedAt: null, rowCount: 3, memberAccess: "view", members: { [KIM.id]: "edit" } }],
    members: [
      { ...me, role: "owner", canAddApps: false },
      { ...LIN, role: "member", canAddApps: false },
      { ...KIM, role: "member", canAddApps: true },
    ],
    invitations: [{ email: "pat@example.com", role: "member", canAddApps: false }],
  };
}

export const test = base.extend<{ api: FakeApi }>({
  api: async ({ page }, use) => {
    const api = new FakeApi();
    await api.install(page);
    await use(api);
  },
});

export { expect };

export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
