/**
 * GitHub Trending of hearth-stones, built into Hearth by
 * playwright.mini-apps.config.ts, used by two people of one family on one
 * server: the owner at a desk, in English, who adds the app and may change
 * it, and Lin on her phone, in Chinese, who may only look. The app's job
 * runs on the server as it does every hour, and the file of stand-in
 * answers both copies read (MINI_APPS_STAND_INS) plays GitHub's search, so
 * that nothing reaches GitHub: no answer at first, then sample searches with
 * spam among them, then GitHub's answer to too many requests. The browsers
 * reach nothing outside either: a link to GitHub opens a stand-in page.
 *
 * The app lives in the other repository (`hearth-stones/trending`); when
 * its texts, layout or searches change there, this file changes with them.
 */
import { rmSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { PHONE, expectNothingPastTheEdge } from "../fixtures.ts";
import { MEMBER_EMAIL, MINI_APPS_MEMBER_URL, MINI_APPS_STAND_INS, writeStandIns } from "../servers.ts";

type Status = { lastStartedAt: string | null; lastSucceededAt: string | null; lastFailedAt: string | null; state: string };
type Session = { user: { id: string }; spaces: { id: string; role: string }[] };

const SEARCH = "https://api.github.com/search/repositories";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** When the sample repositories' ages are counted from. */
const NOW = Date.now();

/** A repository as GitHub's search lists it, with the fields the app reads; made up, as is every one below. */
function repo(id: number, fullName: string, hoursOld: number, stars: number, forks: number, language: string | null, description: string | null) {
  const created = new Date(NOW - hoursOld * HOUR).toISOString();
  return { id, full_name: fullName, description, language, stargazers_count: stars, forks_count: forks, created_at: created };
}

const LANTERN = repo(101, "sample-org/lantern", 74, 4210, 180, "TypeScript", "A small static site generator.");
/** The one the owner hides: on this week's lists of every language and of Rust, and first on this month's Rust. */
const FERRIS = repo(102, "example-labs/ferris-cache", 120, 3105, 95, "Rust", "A cache for build artifacts.");
const NOTES = repo(
  103,
  "sample-org/notes-kept-as-plain-markdown-files-in-a-folder-of-your-own",
  140,
  2004,
  61,
  "Python",
  "Notes kept as plain Markdown files in a folder of your own, with tags, links between notes, " +
    "a calendar of what was written when, and a search that finds a word in every note at once.",
);
const TERM = repo(104, "example-dev/quiet-term", 50, 1500, 40, "Go", "A terminal that stays out of the way.");
const PLANE = repo(105, "sample-org/paper-plane", 96, 1320, 33, "Rust", "Send files across the room.");
const CHARTS = repo(106, "example-labs/small-charts", 150, 990, 12, null, null);
const RUSTY = repo(107, "example-dev/rusty-lines", 130, 640, 14, "Rust", "Line counts for a whole workspace.");
const DOCS = repo(108, "example-dev/pocket-docs", 160, 510, 11, "TypeScript", "Documentation that fits in a pocket.");
const MORNING = repo(201, "sample-org/morning-brief", 10, 820, 9, "TypeScript", "The day's notes on one page.");
const TINY = repo(202, "example-dev/tiny-http", 20, 310, 4, "Go", "An HTTP server in one file.");
const CRAB = repo(203, "example-dev/crab-queue", 15, 205, 3, "Rust", "A queue for background work.");
const BOARD = repo(301, "sample-org/big-board", 600, 9800, 410, "Python", "A board for the whole team's tasks.");

// The spam GitHub's search lets through, one of each kind the app's deny-list knows: a year and an installer,
// crypto bots, fake balances. Each comes before a repository the lists keep, so leaving it out moves the ranks up.
const INSTALLER = repo(901, "xyz-soft/XYZ-2026-Full-Feature-Desktop-Installer", 30, 5200, 220, null, "XYZ 2026: Full-Feature Desktop Installer");
const MINT_BOT = repo(902, "sample-bots/solana-mint-bot", 70, 2500, 70, "TypeScript", "The fastest mint bot.");
const SNIPER_BOT = repo(903, "sample-bots/pump-sniper-bot", 12, 400, 8, "Python", "A sniper bot for new tokens.");
const FAKE_BALANCE = repo(904, "sample-wallets/wallet-tool", 60, 2100, 50, "Rust", "Fake-Balance tool for any wallet.");
const FLASH_USDT = repo(905, "sample-wallets/flash-usdt-sender", 300, 12000, 520, null, "Send flash USDT.");

/**
 * GitHub's answers to the six searches a run asks for once the family
 * follows Rust: each range (the last day, week and month) for every
 * language and for Rust, in GitHub's order, most stars first.
 *
 * An entry answers a search whose `q` holds its text: the filters every
 * search must carry against spam, the fewest forks of its range and, for
 * Rust, the language; and that asks for the most stars first. The ones of
 * Rust come first, since the text of the others is part of theirs. A search
 * none of them answers fails as the network would, and fails its run.
 */
function githubSearches(): unknown[] {
  const answer = (terms: string, items: readonly ReturnType<typeof repo>[]) => ({
    url: SEARCH,
    query: { q: `fork:false archived:false ${terms}`, sort: "stars", order: "desc" },
    body: { total_count: items.length, incomplete_results: false, items },
  });
  return [
    answer("forks:>=3 language:rust", [CRAB]),
    answer("forks:>=10 language:rust", [FERRIS, FAKE_BALANCE, PLANE, RUSTY]),
    answer("forks:>=25 language:rust", [FERRIS, PLANE]),
    answer("forks:>=3", [MORNING, SNIPER_BOT, TINY]),
    answer("forks:>=10", [INSTALLER, LANTERN, FERRIS, MINT_BOT, NOTES, TERM, PLANE, CHARTS, DOCS]),
    answer("forks:>=25", [FLASH_USDT, BOARD, LANTERN]),
  ];
}

/** The lists the app should show of those answers: GitHub's order, without the spam. */
const LISTS = {
  dayAll: [MORNING, TINY],
  dayRust: [CRAB],
  weekAll: [LANTERN, FERRIS, NOTES, TERM, PLANE, CHARTS, DOCS],
  weekRust: [FERRIS, PLANE, RUSTY],
  monthAll: [BOARD, LANTERN],
  monthRust: [FERRIS, PLANE],
};

/** A list as it should read, each repository with its rank: "1 owner/name". */
const numbered = (repos: readonly { full_name: string }[]) => repos.map((repo, index) => `${index + 1} ${repo.full_name}`);
/** The same list with the owner's hidden repository left out, ranked again. */
const withoutHidden = (repos: readonly { full_name: string }[]) => numbered(repos.filter((repo) => repo !== FERRIS));

/**
 * A list as a person reads it: each row's rank and owner/name, "1
 * owner/name", or the text of the row that stands for one just hidden.
 */
function ranked(list: Locator): Promise<string[]> {
  return list.getByRole("listitem").evaluateAll((rows) =>
    rows.map((row) => {
      const link = row.querySelector("a");
      if (link === null) return row.querySelector('[role="status"]')?.textContent ?? "";
      return `${row.firstElementChild?.textContent ?? ""} ${link.textContent ?? ""}`;
    }),
  );
}

/** A moment as the app writes it, on the browser's clock, which is UTC here: "14:05". */
const timeOf = (at: string | null) => new Date(at ?? NaN).toISOString().slice(11, 16);

/** What a browser gets in place of a page of GitHub's: a page of its own, from no network at all. */
const GITHUB_STAND_IN_TITLE = "A stand-in for github.com";

/**
 * Keeps a browser to the test's own servers. A page of github.com is
 * answered by a stand-in, so that a test can follow a link to one, and
 * whatever else a page asks of another host is refused: nothing reaches the
 * network, whatever an app's links say.
 */
async function keepToTheTestServers(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) =>
      new URL(route.request().url()).origin === "https://github.com"
        ? route.fulfill({ contentType: "text/html", body: `<!doctype html><title>${GITHUB_STAND_IN_TITLE}</title>` })
        : route.abort(),
  );
}

/** Collects script errors and anything the browser refused because of the Content-Security-Policy. */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  return problems;
}

test("a family follows GitHub's new repositories: lists without spam, one hidden for both, a refresh GitHub turns down", async ({
  page,
  context,
  request,
  browser,
  playwright,
}) => {
  // Three runs of the job, each followed by the pages every 3 seconds, and a run asked for starts 5 seconds after the last.
  test.setTimeout(120_000);
  // A name of its own, so that a group an earlier run left on a reused server is not taken for this one.
  const groupName = `Trending ${Date.now().toString(36)}`;
  const ownerName = `GitHub Trending in ${groupName}`;
  const linName = `${groupName}的GitHub 热门`;
  const problems = watchForProblems(page);
  await keepToTheTestServers(context);
  // Each page keeps its own time, so that the minutes after a refresh, and waiting for a page to read again, take no real time.
  await page.clock.install();
  const linContext = await browser.newContext({
    ...PHONE,
    baseURL: MINI_APPS_MEMBER_URL,
    locale: "zh-CN",
    timezoneId: "UTC",
    colorScheme: "light",
    serviceWorkers: "block",
  });
  await keepToTheTestServers(linContext);
  const linPage = await linContext.newPage();
  await linPage.clock.install();
  const linProblems = watchForProblems(linPage);
  const linApi = await playwright.request.newContext({ baseURL: MINI_APPS_MEMBER_URL });
  let groupId = "";

  try {
    // Nothing answers the job's searches yet: each fails as the network would.
    rmSync(MINI_APPS_STAND_INS, { force: true });

    // The owner makes a group for the family and invites Lin. She arrives, and reads Chinese.
    const created = await request.post("/api/spaces", { data: { name: groupName } });
    expect(created.status()).toBe(201);
    groupId = ((await created.json()) as { id: string }).id;
    expect((await request.post(`/api/spaces/${groupId}/members`, { data: { email: MEMBER_EMAIL } })).status()).toBe(200);
    const linSession = (await (await linApi.get("/api/session")).json()) as Session;
    expect(linSession.spaces).toContainEqual(expect.objectContaining({ id: groupId, role: "member" }));
    expect((await linApi.patch("/api/me", { data: { locale: "zh" } })).status()).toBe(200);
    const trending = `/api/spaces/${groupId}/apps/trending`;
    const statusNow = async () => (await (await request.get(`${trending}/jobs/refresh`)).json()) as Status;

    // On the Apps page the owner adds GitHub Trending to the group, for everyone to view. The dialog names the one host it fetches from.
    await page.goto("/apps");
    await page.getByRole("main").getByRole("region", { name: groupName }).getByRole("button", { name: "Add an app" }).click();
    const add = page.getByRole("dialog", { name: `Add an app to ${groupName}` });
    await add.getByRole("radio", { name: /GitHub Trending/ }).check();
    await expect(add.getByText("Fetches data from api.github.com on its own.")).toBeVisible();
    await add.getByRole("radio", { name: "Everyone can view" }).check();
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add).toBeHidden();

    // The job's first run follows at once, and fails: nothing answered its searches.
    await expect.poll(async () => (await statusNow()).lastFailedAt).not.toBeNull();
    const first = await statusNow();
    expect(first).toMatchObject({ lastSucceededAt: null, state: "idle" });
    const firstFailure = `Couldn't reach GitHub at ${timeOf(first.lastFailedAt)}.`;

    // The card on the owner's dashboard has no results yet, and says when the refresh failed.
    await page.goto("/");
    const ownerCard = page.getByRole("region", { name: ownerName });
    await expect(ownerCard.getByRole("heading", { name: "No results yet. The first refresh is on its way." })).toBeVisible();
    await expect(ownerCard.getByText(firstFailure, { exact: true })).toBeVisible();

    // So does the app's page, with "Try again" for the owner.
    await ownerCard.getByRole("link", { name: `Open ${ownerName}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: "GitHub Trending" })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "No results yet. The first refresh is on its way." })).toBeVisible();
    await expect(main.getByText(firstFailure, { exact: true })).toBeVisible();
    const tryAgain = main.getByRole("button", { name: "Try again" });
    await expect(tryAgain).toBeEnabled();

    // The owner has the group follow Rust, a setting of the space: the next run searches for it too, and the page has its chip.
    await page.getByRole("button", { name: `Settings of ${ownerName}` }).click();
    const settings = page.getByRole("dialog", { name: "GitHub Trending settings" });
    await settings.getByRole("group", { name: "Languages to follow" }).getByRole("button", { name: "Rust" }).click();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings).toBeHidden();
    const languages = main.getByRole("group", { name: "Language" });
    await expect(languages.getByRole("button")).toHaveText(["All", "Rust"]);

    // GitHub answers now. "Try again" asks for a run, which starts 5 seconds after the last one did, at the latest.
    writeStandIns(MINI_APPS_STAND_INS, githubSearches());
    await tryAgain.click();
    await expect(main.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    await expect.poll(async () => (await statusNow()).lastSucceededAt, { timeout: 15_000 }).not.toBeNull();
    const fetched = await statusNow();
    expect(fetched).toMatchObject({ lastFailedAt: first.lastFailedAt, state: "idle" });

    // This week's list of every language, the owner's own range: ranked as GitHub ranked them, without the spam.
    const weekAll = main.getByRole("list", { name: "This week · All" });
    await expect.poll(() => ranked(weekAll), { timeout: 10_000 }).toEqual(numbered(LISTS.weekAll));
    await expect(main.getByText("Updated just now")).toBeVisible();
    await expect(main.getByText(/Couldn't reach GitHub/)).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Refresh now" })).toBeEnabled();
    // A row: owner/name, the description, the language, stars, forks and how old it is.
    const lantern = weekAll.getByRole("listitem").first();
    for (const text of ["A small static site generator.", "TypeScript", "4,210 stars", "180 forks", "3 d old"]) {
      await expect(lantern).toContainText(text);
    }

    // With the browser's clock 12 minutes on from the refresh, the page says how long ago it was, without reloading.
    const pageNow = await page.evaluate(() => Date.now());
    await page.clock.fastForward(Math.round(Date.parse(fetched.lastSucceededAt ?? "") + 12 * MINUTE + 20_000 - pageNow));
    await expect(main.getByText("Updated 12 min ago")).toBeVisible();

    // Each name leads to the repository on GitHub, in a new tab, which here is a stand-in for GitHub's page.
    const links = weekAll.getByRole("link");
    await expect(links).toHaveCount(LISTS.weekAll.length);
    for (const [index, { full_name: name }] of LISTS.weekAll.entries()) {
      await expect(links.nth(index)).toHaveAttribute("href", `https://github.com/${name}`);
      await expect(links.nth(index)).toHaveAttribute("target", "_blank");
      await expect(links.nth(index)).toHaveAttribute("rel", "noopener noreferrer");
    }
    await expect(links.first()).toHaveAccessibleDescription("opens in a new tab");
    const newTab = context.waitForEvent("page");
    await links.first().click();
    const github = await newTab;
    await expect(github).toHaveURL(`https://github.com/${LANTERN.full_name}`);
    await expect(github).toHaveTitle(GITHUB_STAND_IN_TITLE);
    await github.close();
    await expect(page).toHaveURL(`/apps/${groupId}/trending`);

    // The three ranges and the Rust chip, each a list of its own, without the spam.
    const range = main.getByRole("group", { name: "Range" });
    await expect(range.getByRole("button")).toHaveText(["Today", "This week", "This month"]);
    await range.getByRole("button", { name: "Today" }).click();
    const dayAll = main.getByRole("list", { name: "Today · All" });
    await expect.poll(() => ranked(dayAll)).toEqual(numbered(LISTS.dayAll));
    await expect(dayAll.getByRole("listitem").first()).toContainText("10 h old");
    await languages.getByRole("button", { name: "Rust" }).click();
    await expect.poll(() => ranked(main.getByRole("list", { name: "Today · Rust" }))).toEqual(numbered(LISTS.dayRust));
    await range.getByRole("button", { name: "This month" }).click();
    await expect.poll(() => ranked(main.getByRole("list", { name: "This month · Rust" }))).toEqual(numbered(LISTS.monthRust));
    await languages.getByRole("button", { name: "All" }).click();
    await expect.poll(() => ranked(main.getByRole("list", { name: "This month · All" }))).toEqual(numbered(LISTS.monthAll));
    await range.getByRole("button", { name: "This week" }).click();
    await languages.getByRole("button", { name: "Rust" }).click();
    await expect.poll(() => ranked(main.getByRole("list", { name: "This week · Rust" }))).toEqual(numbered(LISTS.weekRust));
    await languages.getByRole("button", { name: "All" }).click();
    await expect.poll(() => ranked(weekAll)).toEqual(numbered(LISTS.weekAll));

    // The owner hides a repository: its row gives way to a note with "Undo", and the ones after it move up.
    const ferrisRow = weekAll.getByRole("listitem").filter({ has: page.getByRole("link", { name: FERRIS.full_name }) });
    const hiddenNote = [`1 ${LANTERN.full_name}`, `Hid ${FERRIS.full_name}.`, ...withoutHidden(LISTS.weekAll).slice(1)];
    await ferrisRow.getByRole("button", { name: "Hide" }).click();
    await expect.poll(() => ranked(weekAll)).toEqual(hiddenNote);
    // Undo puts it back in its place.
    await weekAll.getByRole("button", { name: "Undo" }).click();
    await expect.poll(() => ranked(weekAll)).toEqual(numbered(LISTS.weekAll));
    await expect(main.getByRole("button", { name: /^Hidden/ })).toHaveCount(0);
    // And the owner hides it again: it is on the group's Hide list.
    await ferrisRow.getByRole("button", { name: "Hide" }).click();
    await expect.poll(() => ranked(weekAll)).toEqual(hiddenNote);
    await expect(main.getByRole("button", { name: "Hidden (1)" })).toBeVisible();
    const hidden = (await (await request.post(`${trending}/q/hidden`, { data: {} })).json()) as { output: unknown[] };
    expect(hidden.output).toEqual([expect.objectContaining({ githubId: FERRIS.id, fullName: FERRIS.full_name })]);

    // Lin, on her phone and in Chinese, finds the group's card: the first five of her own range, this week, without it.
    await linPage.goto("/");
    const linCard = linPage.getByRole("region", { name: linName });
    await expect.poll(() => ranked(linCard.getByRole("list", { name: "本周" }))).toEqual(withoutHidden(LISTS.weekAll).slice(0, 5));
    await expect(linCard.getByText(/^(刚刚更新|\d+ 分钟前更新)$/)).toBeVisible();
    await expectNothingPastTheEdge(linPage);

    // On the app's page she sees the same lists without it, and nothing to press but the range and the languages.
    await linCard.getByRole("link", { name: `打开 ${linName}` }).click();
    await expect(linPage.getByRole("heading", { level: 1, name: "GitHub 热门" })).toBeVisible();
    const linMain = linPage.getByRole("main");
    await expect.poll(() => ranked(linMain.getByRole("list", { name: "本周 · 全部" }))).toEqual(withoutHidden(LISTS.weekAll));
    const linButtons = ["今天", "本周", "本月", "全部", "Rust"];
    await expect(linMain.getByRole("button")).toHaveText(linButtons);
    // The longest name and description on her phone: both stay on the screen.
    await expectNothingPastTheEdge(linPage);
    await linMain.getByRole("group", { name: "语言" }).getByRole("button", { name: "Rust" }).click();
    await expect.poll(() => ranked(linMain.getByRole("list", { name: "本周 · Rust" }))).toEqual(withoutHidden(LISTS.weekRust));
    await linMain.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "本月" }).click();
    const linMonthRust = linMain.getByRole("list", { name: "本月 · Rust" });
    await expect.poll(() => ranked(linMonthRust)).toEqual(withoutHidden(LISTS.monthRust));
    await expect(linMonthRust.getByText(PLANE.description ?? "")).toBeVisible();
    await expect(linMain.getByRole("button")).toHaveText(linButtons);
    await expectNothingPastTheEdge(linPage);

    // She hides the descriptions, for herself alone, which view access allows: they leave her page, the rows stay.
    await linPage.getByRole("button", { name: `${linName}的设置` }).click();
    const linSettings = linPage.getByRole("dialog", { name: "GitHub 热门设置" });
    const hideDescriptions = linSettings.getByRole("switch", { name: "隐藏描述" });
    await expect(hideDescriptions).toBeEnabled();
    await hideDescriptions.click();
    await linSettings.getByRole("button", { name: "保存" }).click();
    await expect(linSettings).toBeHidden();
    await expect(linMonthRust.getByText(PLANE.description ?? "")).toHaveCount(0);
    await expect.poll(() => ranked(linMonthRust)).toEqual(withoutHidden(LISTS.monthRust));
    expect(await (await linApi.get(`${trending}/settings`)).json()).toEqual({
      space: { languages: ["rust"] },
      user: { range: "week", hideDescriptions: true },
    });
    expect(await (await request.get(`${trending}/settings`)).json()).toEqual({
      space: { languages: ["rust"] },
      user: { range: "week", hideDescriptions: false },
    });
    // The owner, opening the page again, still has them.
    await page.reload();
    await expect.poll(() => ranked(weekAll)).toEqual(withoutHidden(LISTS.weekAll));
    await expect(lantern).toContainText("A small static site generator.");

    // GitHub turns the searches down now, as it does past its limit. The owner asks for a refresh, which fails.
    writeStandIns(MINI_APPS_STAND_INS, [{ url: SEARCH, status: 403, body: { message: "API rate limit exceeded" } }]);
    await main.getByRole("button", { name: "Refresh now" }).click();
    await expect(main.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    await expect
      .poll(
        async () => {
          const { lastFailedAt, lastSucceededAt } = await statusNow();
          return lastFailedAt !== null && lastSucceededAt !== null && lastFailedAt > lastSucceededAt;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const failed = await statusNow();
    expect(failed.lastSucceededAt).toBe(fetched.lastSucceededAt);

    // The owner's page says in a banner when the refresh failed and when the lists shown are from, with "Try again".
    const failure = `Couldn't reach GitHub at ${timeOf(failed.lastFailedAt)}. Showing results from ${timeOf(fetched.lastSucceededAt)}.`;
    await expect(main.getByText(failure, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(main.getByRole("button", { name: "Try again" })).toBeEnabled();
    await expect(main.getByRole("button", { name: "Refresh now" })).toHaveCount(0);
    expect(await ranked(weekAll)).toEqual(withoutHidden(LISTS.weekAll));
    // Nothing of the failed run was kept: the lists are the last good run's.
    const weekNow = (await (await request.post(`${trending}/q/list`, { data: { input: { range: "week" } } })).json()) as {
      output: { fullName: string }[];
    };
    expect(weekNow.output.map((row) => row.fullName)).toEqual(LISTS.weekAll.filter((repo) => repo !== FERRIS).map((repo) => repo.full_name));

    // Lin's page, left open, reads the status again within 15 seconds: the same banner, in Chinese, and no button.
    await linPage.clock.runFor(16_000);
    const linFailure = `${timeOf(failed.lastFailedAt)} 时无法连接 GitHub。现在显示的是 ${timeOf(fetched.lastSucceededAt)} 的结果。`;
    await expect(linMain.getByText(linFailure, { exact: true })).toBeVisible();
    await expect(linMain.getByRole("button")).toHaveText(linButtons);
    // Opened again, her page shows it over the lists the server kept, still without descriptions for her.
    await linPage.reload();
    const linWeekAll = linMain.getByRole("list", { name: "本周 · 全部" });
    await expect.poll(() => ranked(linWeekAll)).toEqual(withoutHidden(LISTS.weekAll));
    await expect(linMain.getByText(linFailure, { exact: true })).toBeVisible();
    await expect(linWeekAll.getByText(LANTERN.description ?? "")).toHaveCount(0);
    await expect(linMain.getByRole("button")).toHaveText(linButtons);
    await expectNothingPastTheEdge(linPage);
    // Nor does the server let her ask for a run.
    expect((await linApi.post(`${trending}/jobs/refresh/run`)).status()).toBe(403);

    expect(problems).toEqual([]);
    expect(linProblems).toEqual([]);
  } finally {
    // The group stays (nothing deletes a space). The app leaves it, so that its job does not go on
    // running on a server that the next run reuses.
    if (groupId) await request.delete(`/api/spaces/${groupId}/apps/trending`);
    await linApi.dispose();
    await linContext.close();
  }
});
