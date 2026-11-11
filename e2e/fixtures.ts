/**
 * Shared set-up for the end-to-end tests.
 *
 * `api` stands in for the server: it answers GET /api/session and
 * PATCH /api/me from memory, checks both against the shared contract, and
 * remembers what was saved, so a reload sees it. All names and addresses are
 * made up.
 */
import { expect, test as base, type Page, type Route } from "@playwright/test";
import {
  preferencesPatchSchema,
  sessionSchema,
  type ApiErrorCode,
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

/** A member with a family space and a few sample apps, to exercise the lists that are empty today. */
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

    return fail({ status: 404, code: "not_found", message: "No such route" });
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
