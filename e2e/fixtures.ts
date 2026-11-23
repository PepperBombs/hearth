/**
 * Shared set-up for the end-to-end tests.
 *
 * `api` stands in for the server: it answers GET /api/session and
 * PATCH /api/me from memory, checks both against the shared contract, and
 * remembers what was saved, so a reload sees it. Every app it lists is an
 * app made in Hearth (docs/platform.md), and it answers for them as the
 * server would: each app's page, which the shell draws in a sandboxed
 * frame, as a small page of the stand-in's own (`framePage`); the apps'
 * settings, from what each one declares; the built-in apps it ships
 * (`catalog`), added to a space or brought back with the data the space
 * kept; removing an app, moving one to another space, and each person's
 * switch and pin. And it keeps groups: creating one, renaming it, adding,
 * changing and removing people, invitations, the owners' list of a group
 * and who can use each app (`groups`, `people`). The owners' list of a
 * space no test set up, a personal one included, is drawn from the
 * session. It answers for the chat too: the person's model (`model`),
 * their conversations in each space (`chats`), read, listed and deleted,
 * and a message, which its own made-up model answers with "Noted: " and
 * the message. All names and addresses are made up.
 */
import { expect, test as base, type FrameLocator, type Page, type Route } from "@playwright/test";
import type { Setting } from "../packages/sdk/src/index.ts";
import {
  addFromCatalogRequestSchema,
  addMemberRequestSchema,
  appAccessRequestSchema,
  appPrefsPatchSchema,
  appSettingsPatchSchema,
  appSettingsSchema,
  catalogAppSchema,
  chatListSchema,
  chatRequestSchema,
  chatSchema,
  createSpaceRequestSchema,
  memberPatchSchema,
  modelSettingsSchema,
  moveAppRequestSchema,
  preferencesPatchSchema,
  sessionSchema,
  spaceAppsSchema,
  spacePatchSchema,
  withdrawInvitationRequestSchema,
  type ApiErrorCode,
  type AppSettings,
  type AppSummary,
  type CatalogApp,
  type Chat,
  type ChatEvent,
  type ChatRequest,
  type ModelSettings,
  type PreferencesPatch,
  type Session,
  type SettingValue,
  type SpaceApps,
  type SpaceMember,
  type WidgetSize,
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
        assistant: "none",
        members: [{ id: user.id, name: user.name, role: "owner" }],
      },
    ],
    apps: [],
    canCreateGroups: false,
    canInvitePeople: false,
    version: "a1b2c3d",
  };
}

/**
 * An app made in Hearth, as the session lists it (every app a server lists
 * is one): its page drawn small in its card on the dashboard, and whole on
 * a page of its own.
 */
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
    made: true,
    version: 1,
    ...extra,
  };
}

/**
 * A member with a family space and a few apps made in the chat, to exercise
 * the shell's own lists: sidebar, dashboard grid, app list, quick switcher.
 * Each card and page holds the stand-in's page for the app (`framePage`).
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
        assistant: "none",
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

/** The built-in apps the stand-in ships, in the order GET /api/catalog lists them. */
export const BUILT_IN_IDS = ["checklist", "feed"] as const;
export type BuiltInId = (typeof BUILT_IN_IDS)[number];

/** A built-in app: what GET /api/catalog says of it, and what an app added from it declares. */
type BuiltIn = Omit<CatalogApp, "id"> & { widgetSize: WidgetSize; settings: Record<string, Setting> };

/**
 * What the stand-in's built-in apps are, made up as everything here: the
 * checklist, whose settings are the space's sections and each person's
 * "Hide ticked items", and the feed, which fetches from a host of its own
 * and whose topics and period each person picks.
 */
const BUILT_IN: Record<BuiltInId, BuiltIn> = {
  checklist: {
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
  },
  feed: {
    name: { en: "Feed", zh: "动态" },
    description: { en: "The latest posts of a sample feed, which each person filters for themselves.", zh: "示例订阅源的最新动态，每个人可以自行筛选。" },
    icon: "trending-up",
    color: "purple",
    network: ["feeds.example.com"],
    widgetSize: "wide",
    settings: {
      topics: {
        type: "multi-select",
        scope: "user",
        default: [],
        options: { science: { en: "Science", zh: "科学" }, sport: { en: "Sport", zh: "体育" }, food: { en: "Food", zh: "美食" } },
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
  },
};

/** A built-in app as GET /api/catalog lists it. */
function catalogApp(id: BuiltInId): CatalogApp {
  const { name, description, icon, color, network } = BUILT_IN[id];
  return { id, name, description, icon, color, network };
}

/**
 * An app added from one of the stand-in's built-in apps, in a space, as the
 * session lists it. Its ID is `m-` and the built-in app's (on a server, `m-`
 * and ten letters and digits): a second copy of one needs an `id` of its own.
 */
export function builtInApp(template: BuiltInId, spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  const about = BUILT_IN[template];
  return app(`m-${template}`, spaceId, about.name.en, about.name.zh, about.description.en, about.description.zh, about.icon, about.color, {
    widgetSize: about.widgetSize,
    template,
    settings: about.settings,
    ...extra,
  });
}

/** A member whose spaces hold two built-in apps: the checklist in the family space, and the feed in their own. */
export function sessionWithBuiltInApps(overrides: Partial<Session["user"]> = {}): Session {
  return { ...sessionWithApps(overrides), apps: [builtInApp("checklist", FAMILY_SPACE), builtInApp("feed", PERSONAL_SPACE)] };
}

/** The settings an app declares, as an SDK manifest declares them: what the session hands on for the settings dialog. */
const declaredSettings = (app: AppSummary): Record<string, Setting> => (app.settings ?? {}) as Record<string, Setting>;

/** A setting's default as a value to answer with: a list is copied, since nothing changes a default. */
const valueOf = (value: Setting["default"]): SettingValue => (typeof value === "object" ? [...value] : value);

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * The page the stand-in serves for an app's sandboxed frame (GET
 * .../frame). On a server it is the app's own page with the bridge in front
 * of it; here it is a small page of the stand-in's own, which names the app
 * in the language the frame asked for and says on its elements what else it
 * was asked: the theme and language on `<html>` (`data-theme`, `lang`),
 * where it is drawn and which version on `<body>` (`data-view`,
 * `data-version`). Like every page behind the bridge it reports its height,
 * and it counts the times the shell told it that the app's data or
 * settings changed (`data-changes` on `<body>`).
 */
function framePage(app: AppSummary, query: URLSearchParams): string {
  const locale = query.get("locale") === "zh" ? "zh" : "en";
  const theme = query.get("theme") === "dark" ? "dark" : "light";
  const view = query.get("view") === "page" ? "page" : "card";
  const colours = theme === "dark" ? "background:#1a2029;color:#e6eaf0" : "background:#ffffff;color:#141a24";
  const name = escapeHtml(app.name[locale]);
  return `<!doctype html>
<html lang="${locale === "zh" ? "zh-CN" : "en"}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>${name}</title>
<style>:root{color-scheme:${theme}}body{margin:0;${colours};font:14px/1.5 system-ui,sans-serif}h1{margin:0 0 4px;font-size:14px}p{margin:0}</style>
</head>
<body data-view="${view}" data-version="${escapeHtml(query.get("v") ?? "")}" data-changes="0">
<h1>${name}</h1>
<p>${locale === "zh" ? "测试替身提供的页面。" : "A page of the stand-in server."}</p>
<script>
  let heard = 0;
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.type !== "hearth:changed") return;
    heard += 1;
    document.body.dataset.changes = String(heard);
  });
  const report = () => parent.postMessage({ type: "hearth:size", height: Math.ceil(document.body.scrollHeight) }, "*");
  new ResizeObserver(report).observe(document.body);
</script>
</body>
</html>
`;
}

/** What an app's sandboxed frame shows, by the app's ID: a page draws an app once. */
export function sandbox(page: Page, appId: string): FrameLocator {
  return page.frameLocator(`iframe[data-made-app="${appId}"]`);
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

  /** The built-in apps GET /api/catalog lists, which the Add dialog offers: every one the stand-in ships, unless a test says otherwise. */
  catalog: BuiltInId[] = [...BUILT_IN_IDS];
  /**
   * What was saved of each app's settings, by app ID: the values the space
   * shares and the person's own. GET .../settings answers every setting the
   * app declares, with its default where nothing was saved, as the server
   * does.
   */
  appSettings: Record<string, AppSettings> = {};
  /**
   * Make every route for an app in a space fail but its page, adding a
   * built-in app included: for example `{ status: 409, code: "conflict", message: "Sample failure" }`.
   */
  appFailure: Failure | null = null;
  /**
   * Every change asked of the routes for apps in a space (adding a built-in
   * app, removing, moving, the person's switch and pin, settings), as
   * "METHOD path body", whether or not it was made.
   */
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

  /** What GET /api/me/model answers: the person's own model, or null when they chose none. Checked against the contract. */
  model: ModelSettings | null = null;
  /**
   * The person's own conversations, by space ID, each whole: what
   * GET /api/spaces/:spaceId/chats lists (the one used last first) and
   * GET .../chats/:chatId reads, and what POST /api/chat adds to.
   */
  chats: Record<string, Chat[]> = {};
  /** Every message POST /api/chat accepted, in order. */
  readonly chatRequests: ChatRequest[] = [];

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
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body: unknown = request.postDataJSON();
    const fail = (failure: Failure) =>
      route.fulfill({ status: failure.status, json: { error: { code: failure.code, message: failure.message } } });
    const answer = (result: { json?: unknown; status?: number } | Failure) => {
      if ("code" in result) return fail(result);
      return result.json === undefined ? route.fulfill({ status: result.status ?? 204 }) : route.fulfill({ status: result.status ?? 200, json: result.json });
    };

    if (path === "/api/session" && method === "GET") {
      this.sessionRequests += 1;
      if (this.sessionFailure) return fail(this.sessionFailure);
      return route.fulfill({ json: this.current });
    }

    if (path === "/api/me" && method === "PATCH") {
      if (this.failSaves) return fail({ status: 500, code: "internal", message: "Sample failure" });
      const parsed = preferencesPatchSchema.safeParse(body);
      if (!parsed.success) return fail({ status: 400, code: "invalid_request", message: "Sample failure" });
      this.saved.push(parsed.data);
      this.current = { ...this.current, user: { ...this.current.user, ...parsed.data } };
      return route.fulfill({ json: this.current.user });
    }

    // The apps shipped with Hearth (docs/platform.md, "Built-in apps"), as this stand-in ships them.
    if (path === "/api/catalog" && method === "GET") {
      return route.fulfill({ json: catalogAppSchema.array().parse(this.catalog.map(catalogApp)) });
    }

    const fromCatalog = /^\/api\/spaces\/([^/]+)\/catalog\/([^/]+)$/.exec(path);
    if (fromCatalog && method === "POST") {
      const [, spaceId = "", templateId = ""] = fromCatalog;
      this.appChanges.push(`POST ${path} ${JSON.stringify(body ?? null)}`);
      if (this.appFailure) return fail(this.appFailure);
      return answer(this.addFromCatalog(spaceId, templateId, body));
    }

    if (path === "/api/me/model" && method === "GET") {
      return route.fulfill({ json: this.model === null ? null : modelSettingsSchema.parse(this.model) });
    }

    const forChats = /^\/api\/spaces\/([^/]+)\/chats(?:\/([^/]+))?$/.exec(path);
    if (forChats) {
      const [, spaceId = "", chatId] = forChats;
      return answer(this.answerForChats(spaceId, chatId, method));
    }

    if (path === "/api/chat" && method === "POST") {
      const result = this.answerChat(body);
      if ("code" in result) return fail(result);
      const stream = result.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: stream });
    }

    const forGroups = this.answerForGroups(path, method, body);
    if (forGroups) {
      if ("status" in forGroups) return fail(forGroups);
      return forGroups.json === undefined ? route.fulfill({ status: 204 }) : route.fulfill({ status: forGroups.created ? 201 : 200, json: forGroups.json });
    }

    const forApp = /^\/api\/spaces\/([^/]+)\/apps\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (forApp) {
      const [, spaceId = "", appId = "", rest = ""] = forApp;
      // As on the server: an app the session does not list is not there at all.
      const listed = this.current.apps.find((candidate) => candidate.spaceId === spaceId && candidate.id === appId);
      if (rest === "frame" && method === "GET") {
        if (!listed) return fail({ status: 404, code: "not_found", message: "No such app" });
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: framePage(listed, url.searchParams) });
      }
      if (method !== "GET") this.appChanges.push(`${method} ${path} ${JSON.stringify(body ?? null)}`);
      if (this.appFailure) return fail(this.appFailure);
      const result = listed ? this.answerForApp(listed, rest, method, body) : undefined;
      return result === undefined ? fail({ status: 404, code: "not_found", message: "No such app or route" }) : answer(result);
    }

    return fail({ status: 404, code: "not_found", message: "No such route" });
  }

  /** The person's conversations in a space of theirs, or undefined when they are not in it. */
  private chatsIn(spaceId: string): Chat[] | undefined {
    if (!this.current.spaces.some((space) => space.id === spaceId)) return undefined;
    return (this.chats[spaceId] ??= []);
  }

  /** The routes of the person's conversations in a space, as the server answers them: 404 for a space or conversation not theirs. */
  private answerForChats(spaceId: string, chatId: string | undefined, method: string): { json?: unknown; status?: number } | Failure {
    const missing: Failure = { status: 404, code: "not_found", message: "Sample failure" };
    const chats = this.chatsIn(spaceId);
    if (!chats) return missing;
    if (chatId === undefined) {
      if (method !== "GET") return missing;
      const listed = [...chats].sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt) || a.chat.id.localeCompare(b.chat.id));
      return { json: chatListSchema.parse({ chats: listed.map((entry) => entry.chat) }) };
    }
    const index = chats.findIndex((entry) => entry.chat.id === chatId);
    if (index < 0) return missing;
    if (method === "GET") return { json: chatSchema.parse(chats[index]) };
    if (method === "DELETE") {
      chats.splice(index, 1);
      return { status: 204 };
    }
    return missing;
  }

  /**
   * POST /api/chat, as the server answers it with a model that only takes
   * note: the events of its stream, the first being "chat" when the message
   * started a new conversation, titled after it. What is said is kept.
   */
  private answerChat(body: unknown): ChatEvent[] | Failure {
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) return { status: 400, code: "invalid_request", message: "Sample failure" };
    const { spaceId, chatId, message } = parsed.data;
    const chats = this.chatsIn(spaceId);
    const known = chatId === undefined ? undefined : chats?.find((entry) => entry.chat.id === chatId);
    if (!chats || (chatId !== undefined && !known)) return { status: 404, code: "not_found", message: "Sample failure" };
    this.chatRequests.push(parsed.data);
    const now = new Date().toISOString();
    const events: ChatEvent[] = [];
    let chat = known;
    if (!chat) {
      // As the server titles it: the message on one line, cut at 80 characters.
      const line = message.replace(/\s+/g, " ").trim();
      const title = line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line;
      chat = { chat: { id: `chat-${this.chatRequests.length}`, title, createdAt: now, updatedAt: now }, entries: [] };
      chats.push(chat);
      events.push({ type: "chat", chatId: chat.chat.id, title });
    }
    const answer = `Noted: ${message}`;
    chat.entries.push({ kind: "user", text: message }, { kind: "model", text: answer });
    chat.chat = { ...chat.chat, updatedAt: now };
    events.push({ type: "text", text: answer }, { type: "done" });
    return events;
  }

  /**
   * POST /api/spaces/:spaceId/catalog/:templateId, as the server answers it:
   * the built-in app added to the space as an app of its own, for whoever may
   * add apps there, or the one the space removed brought back with its data,
   * for an owner. Who can use it starts afresh either way, and the owners'
   * list of a group follows.
   */
  private addFromCatalog(spaceId: string, templateId: string, body: unknown): { json: unknown; status: number } | Failure {
    const refuse = (status: number, code: ApiErrorCode): Failure => ({ status, code, message: "Sample failure" });
    const parsed = addFromCatalogRequestSchema.safeParse(body);
    if (!parsed.success) return refuse(400, "invalid_request");
    const space = this.current.spaces.find((candidate) => candidate.id === spaceId);
    const template = this.catalog.find((id) => id === templateId);
    if (!space || !template) return refuse(404, "not_found");
    if (!space.canAddApps) return refuse(403, "forbidden");
    if (this.current.apps.some((candidate) => candidate.spaceId === spaceId && candidate.template === template)) return refuse(409, "conflict");
    const owner = space.role === "owner";
    const memberAccess = parsed.data.memberAccess ?? "none";
    const owners = this.groups[spaceId];
    const removed = owners?.apps.find((entry) => entry.template === template && entry.removedAt !== null);
    if (removed) {
      // Only an owner brings a removed app back: its data comes with it.
      if (!owner) return refuse(409, "conflict");
      Object.assign(removed, { removedAt: null, memberAccess, members: {}, assistant: true });
      this.setSession({ ...this.current, apps: [...this.current.apps, builtInApp(template, spaceId, { id: removed.id })] });
      return { status: 200, json: { appId: removed.id, restored: true } };
    }
    const appId = this.freeAppId(template);
    // Someone who is not an owner keeps edit for themselves, as on the server.
    const members = owner ? {} : { [this.current.user.id]: "edit" as const };
    owners?.apps.push({ id: appId, template, hasCode: true, removedAt: null, rowCount: 0, memberAccess, members, assistant: true });
    this.setSession({ ...this.current, apps: [...this.current.apps, builtInApp(template, spaceId, { id: appId })] });
    return { status: 201, json: { appId, restored: false } };
  }

  /** An app ID that nothing the stand-in knows has: `m-` and the built-in app's, then `-2`, `-3` and so on. */
  private freeAppId(template: BuiltInId): string {
    const taken = new Set([
      ...this.current.apps.map((candidate) => candidate.id),
      ...Object.values(this.groups).flatMap((list) => list.apps.map((entry) => entry.id)),
    ]);
    for (let n = 1; ; n += 1) {
      const id = n === 1 ? `m-${template}` : `m-${template}-${n}`;
      if (!taken.has(id)) return id;
    }
  }

  /** What the routes for one app the session lists answer, as the server would. Undefined: nothing at this address. */
  private answerForApp(listed: AppSummary, rest: string, method: string, body: unknown): { json?: unknown; status?: number } | Failure | undefined {
    const refuse = (status: number, code: ApiErrorCode): Failure => ({ status, code, message: "Sample failure" });
    const space = this.current.spaces.find((candidate) => candidate.id === listed.spaceId);
    // The owners' list of a group follows: a removed app is marked so.
    const owners = this.groups[listed.spaceId];

    if (rest === "" && method === "DELETE") {
      if (space?.role !== "owner") return refuse(403, "forbidden");
      this.setSession({ ...this.current, apps: this.current.apps.filter((candidate) => candidate !== listed) });
      for (const entry of owners?.apps ?? []) if (entry.id === listed.id) entry.removedAt = "2026-11-10T08:00:00.000Z";
      return {};
    }
    if (rest === "me" && method === "PATCH") {
      const patch = appPrefsPatchSchema.safeParse(body);
      if (!patch.success) return refuse(400, "invalid_request");
      this.setSession({ ...this.current, apps: this.current.apps.map((candidate) => (candidate === listed ? { ...candidate, ...patch.data } : candidate)) });
      return {};
    }
    if (rest === "move" && method === "POST") {
      return this.moveApp(listed, body) ?? {};
    }
    if (rest === "settings" && method === "GET") return { json: this.settingsOf(listed) };
    if (rest === "settings" && method === "PATCH") {
      const patch = appSettingsPatchSchema.safeParse(body);
      if (!patch.success) return refuse(400, "invalid_request");
      // As on the server: only what the app declares, each in its scope; the space's need edit access, the person's own only view.
      const declared = declaredSettings(listed);
      for (const scope of ["space", "user"] as const) {
        for (const name of Object.keys(patch.data[scope] ?? {})) if (declared[name]?.scope !== scope) return refuse(400, "invalid_request");
      }
      if (listed.access === "view" && Object.keys(patch.data.space ?? {}).length > 0) return refuse(403, "forbidden");
      const saved = this.appSettings[listed.id] ?? { space: {}, user: {} };
      this.appSettings[listed.id] = { space: { ...saved.space, ...patch.data.space }, user: { ...saved.user, ...patch.data.user } };
      return { json: this.settingsOf(listed) };
    }
    return undefined;
  }

  /** An app's settings as GET .../settings answers them: every one it declares, saved or by default. */
  private settingsOf(listed: AppSummary): AppSettings {
    const saved = this.appSettings[listed.id] ?? { space: {}, user: {} };
    const settings: AppSettings = { space: {}, user: {} };
    for (const [name, setting] of Object.entries(declaredSettings(listed))) {
      settings[setting.scope][name] = saved[setting.scope][name] ?? valueOf(setting.default);
    }
    return appSettingsSchema.parse(settings);
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
        assistant: "none" as const,
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
    // The owners' list is there for a personal space too. One a test did not set up is drawn from the session.
    if (part === "apps" && method === "GET") {
      if (!space) return refuse(404, "not_found");
      if (space.role !== "owner") return refuse(403, "forbidden");
      return { json: spaceAppsSchema.parse(details ?? this.listFromSession(space)) };
    }
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

  /** The owners' list of a space a test gave none: its apps as the session lists them, and its people. */
  private listFromSession(space: Session["spaces"][number]): SpaceApps {
    const me = this.current.user;
    return {
      apps: this.current.apps
        .filter((app) => app.spaceId === space.id)
        .map((app) => ({
          id: app.id,
          hasCode: true,
          removedAt: null,
          rowCount: 0,
          memberAccess: "none" as const,
          members: {},
          assistant: true,
          ...(app.template === undefined ? {} : { template: app.template }),
        })),
      members: space.members.map((member) => {
        const known = member.id === me.id ? me : this.people.find((person) => person.id === member.id);
        return { ...member, email: known?.email ?? `${member.id}@example.com`, canAddApps: false };
      }),
      invitations: [],
    };
  }

  /**
   * Moves an app the session lists to another of the person's spaces, as
   * the server would: they must own the space it is in and may add apps to
   * the other, which must not have it. Access there starts afresh, and the
   * owners' lists of both spaces follow; its settings go with it. Answers
   * the refusal, or nothing once the app is moved.
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
      // What an assistant may do with it starts afresh too, as on the server.
      assistant: true,
      ...(listed.template === undefined ? {} : { template: listed.template }),
    });
    // The mover can always use it where it went: as an owner, or by that exception.
    this.setSession({ ...this.current, apps: this.current.apps.map((app) => (app === listed ? { ...app, spaceId: to.id, access: "edit" } : app)) });
    return undefined;
  }
}

/** Two people on the stand-in server besides the signed-in one: the family's other members. */
export const LIN: KnownPerson = { id: "user-2", name: "Lin Example", email: "lin@example.com" };
export const KIM: KnownPerson = { id: "user-3", name: "Kim Example", email: "kim@example.com" };

/**
 * The signed-in person as the server's owner, who owns the family: Lin is a
 * member, Kim a member who may add apps, and Pat is invited and has not
 * arrived. The family has the checklist, added from the built-in apps,
 * which every member may view and Kim may change.
 */
export function ownAFamily(api: FakeApi, user: Partial<Session["user"]> = {}): void {
  const session = emptySession(user);
  const me = { id: session.user.id, name: session.user.name, email: session.user.email };
  const checklist = builtInApp("checklist", FAMILY_SPACE);
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
        assistant: "none",
        members: [
          { id: me.id, name: me.name, role: "owner" },
          { id: LIN.id, name: LIN.name, role: "member" },
          { id: KIM.id, name: KIM.name, role: "member" },
        ],
      },
    ],
    apps: [checklist],
  });
  api.groups[FAMILY_SPACE] = {
    apps: [
      { id: checklist.id, template: "checklist", hasCode: true, removedAt: null, rowCount: 3, memberAccess: "view", members: { [KIM.id]: "edit" }, assistant: true },
    ],
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

/** The parts of the shell meant to scroll sideways by themselves on a phone: the table of who can use each app. */
export const SIDEWAYS_SCROLLERS: readonly string[] = ['[data-testid="access-scroller"]'];

/**
 * Nothing may reach past the edge of the screen. The document's own width
 * says nothing about that: the shell clips what does not fit and the content
 * area scrolls by itself, so the page never grows. Each part is measured.
 *
 * What is inside an element meant to scroll sideways by itself is left to
 * that element, which must still fit: `scrollers` names such elements by
 * selector, the shell's own (`SIDEWAYS_SCROLLERS`) unless told otherwise.
 */
export async function expectNothingPastTheEdge(page: Page, scrollers: readonly string[] = SIDEWAYS_SCROLLERS): Promise<void> {
  const problems = await page.evaluate((selectors) => {
    const width = document.documentElement.clientWidth;
    const found: string[] = [];
    if (document.documentElement.scrollWidth > width) found.push("the document scrolls sideways");
    const main = document.querySelector("main#content");
    if (!main) found.push("there is no main#content");
    else if (main.scrollWidth > main.clientWidth) found.push("the content area scrolls sideways");
    for (const element of document.querySelectorAll("header, header *, main#content *, nav, nav *")) {
      if (selectors.some((selector) => element.parentElement?.closest(selector))) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.left < -0.5 || box.right > width + 0.5) {
        const text = (element.textContent ?? "").trim().slice(0, 40);
        found.push(`<${element.tagName.toLowerCase()}> "${text}" spans ${box.left} to ${box.right}`);
      }
    }
    return found;
  }, scrollers);
  expect(problems).toEqual([]);
}
