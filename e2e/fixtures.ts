/**
 * Shared set-up for the end-to-end tests.
 *
 * `api` stands in for the server: it answers GET /api/session and
 * PATCH /api/me from memory, checks both against the shared contract, and
 * remembers what was saved, so a reload sees it. It also answers for the
 * framework's two sample apps (packages/fixture-apps), which the tested
 * build holds: the checklist's routes, from a list kept here, and both
 * apps' settings. All names and addresses are made up.
 */
import { expect, test as base, type Page, type Route } from "@playwright/test";
import {
  appCallRequestSchema,
  appCallResponseSchema,
  appSettingsSchema,
  preferencesPatchSchema,
  sessionSchema,
  type ApiErrorCode,
  type AppSettings,
  type AppSummary,
  type PreferencesPatch,
  type Session,
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
    apps: [
      app("checklist", FAMILY_SPACE, "Checklist", "清单", "A list of things to do, ticked off as you go.", "一份待办清单，完成一项勾选一项。", "list-checks", "teal", {
        widgetSize: "tall",
        ...checklist,
      }),
      app("feed", PERSONAL_SPACE, "Feed", "动态", "A sample card that each person filters for themselves.", "每个人可以自行筛选的示例卡片。", "trending-up", "purple", {
        widgetSize: "wide",
        hasPage: false,
      }),
    ],
  };
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

    const forApp = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)\/(.+)$/.exec(path);
    if (forApp) {
      this.appRequests.push(`${request.method()} ${path}`);
      if (this.held) await this.held;
      if (this.appFailure) return fail(this.appFailure);
      const [, spaceId = "", appId = "", rest = ""] = forApp;
      // As on the server: an app the session does not list is not there at all.
      const listed = this.current.apps.some((candidate) => candidate.spaceId === spaceId && candidate.id === appId);
      const answer = listed ? this.answerForApp(appId, rest, request.method(), request.postDataJSON()) : undefined;
      if (answer === undefined) return fail({ status: 404, code: "not_found", message: "No such app or route" });
      if ("status" in answer) return fail(answer);
      return route.fulfill({ json: answer.json });
    }

    return fail({ status: 404, code: "not_found", message: "No such route" });
  }

  /** What the sample apps answer, checked against the shared contract. Undefined: nothing at this address. */
  private answerForApp(appId: string, rest: string, method: string, body: unknown): { json: unknown } | Failure | undefined {
    const settings = this.appSettings[appId];
    if (rest === "settings" && method === "GET" && settings) return { json: appSettingsSchema.parse(settings) };
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

export const test = base.extend<{ api: FakeApi }>({
  api: async ({ page }, use) => {
    const api = new FakeApi();
    await api.install(page);
    await use(api);
  },
});

export { expect };

export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
