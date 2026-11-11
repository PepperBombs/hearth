import {
  FAMILY_SPACE,
  PHONE,
  expect,
  expectNothingPastTheEdge,
  sessionWithApps,
  sessionWithSampleApps,
  test,
} from "./fixtures.ts";

test.describe("shell on a desktop", () => {
  test("shows the sidebar, top bar and an empty dashboard", async ({ page, api }) => {
    await page.goto("/");

    const sidebar = page.getByRole("navigation", { name: "Main" });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText("Hearth", { exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /Search or jump to/ })).toContainText("Ctrl K");
    await expect(sidebar.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await expect(sidebar.getByRole("link", { name: "Apps" })).toBeVisible();
    await expect(sidebar.getByRole("heading", { name: "Personal" })).toBeVisible();
    await expect(sidebar.getByText("No apps yet")).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Dark mode" })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /中文/ })).toBeVisible();

    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page).toHaveTitle("Dashboard · Hearth");
    await expect(page.getByRole("heading", { name: "No widgets yet" })).toBeVisible();
    await expect(page.getByText("Widgets appear here when apps are added.")).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: "Go to the Apps page" })).toBeVisible();

    await expect(page.getByRole("navigation", { name: "Tabs" })).toBeHidden();
    expect(api.sessionRequests).toBe(1);
  });

  test("leads to the Apps page, where apps are added, from the sidebar and from the empty dashboard", async ({ page, api }) => {
    void api;
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });

    await sidebar.getByRole("link", { name: "Apps" }).click();
    await expect(page).toHaveURL(/\/apps$/);
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Apps" })).toHaveAttribute("aria-current", "page");
    await expect(sidebar.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current", "page");

    await sidebar.getByRole("link", { name: "Dashboard" }).click();
    await page.getByRole("main").getByRole("link", { name: "Go to the Apps page" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
  });

  test("lists enabled apps under Personal and under each group space", async ({ page, api }) => {
    api.setSession(sessionWithApps());
    await page.goto("/");

    const sidebar = page.getByRole("navigation", { name: "Main" });
    const personal = sidebar.getByRole("region", { name: "Personal" });
    await expect(personal.getByRole("link")).toHaveText(["GitHub Trending", "Stocks", "Notes"]);
    const family = sidebar.getByRole("region", { name: "Family" });
    await expect(family.getByRole("link")).toHaveText(["Grocery"]);
    // Switched off, so shown nowhere.
    await expect(page.getByText("Finance")).toHaveCount(0);

    await family.getByRole("link", { name: "Grocery" }).click();
    await expect(page).toHaveURL(/\/apps\/space-family\/grocery$/);
    await expect(page.getByRole("heading", { level: 1, name: "Grocery" })).toBeVisible();
    await expect(family.getByRole("link", { name: "Grocery" })).toHaveAttribute("aria-current", "page");
    // The app's own page is not the Apps page.
    await expect(sidebar.getByRole("link", { name: "Apps" })).not.toHaveAttribute("aria-current", "page");
  });

  test("says that a space's apps are widgets only when none of them has a page", async ({ page, api }) => {
    // The feed in the personal space has only a widget; the family's checklist has a page.
    api.setSession(sessionWithSampleApps());
    await page.goto("/");
    const sidebar = page.getByRole("navigation", { name: "Main" });
    const personal = sidebar.getByRole("region", { name: "Personal" });
    await expect(personal.getByText("Widgets only, on the dashboard")).toBeVisible();
    await expect(personal.getByText("No apps yet")).toHaveCount(0);
    await expect(sidebar.getByRole("region", { name: "Family" }).getByRole("link")).toHaveText(["Checklist"]);
    await expect(page.getByTestId("widget-grid").getByRole("heading", { level: 2 })).toHaveText(["Checklist", "Feed"]);
  });

  test("lays widgets out in four columns, then two, then one", async ({ page, api }) => {
    api.setSession(sessionWithApps());
    await page.goto("/");
    const grid = page.getByTestId("widget-grid");
    const columns = () => grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);

    await expect(grid.getByRole("heading", { level: 2 })).toHaveText(["Grocery", "GitHub Trending", "Stocks", "Notes"]);
    await expect(grid.getByText("Family", { exact: true })).toBeVisible();
    expect(await columns()).toBe(4);
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect.poll(columns).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(columns).toBe(1);
  });

  test("groups the app list under Pinned, Personal and each group space", async ({ page, api }) => {
    api.setSession(sessionWithApps());
    await page.goto("/apps");

    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Pinned", "Personal", "Family"]);
    const section = (name: string) => page.getByRole("main").locator("section", { has: page.getByRole("heading", { name }) });
    await expect(section("Pinned").getByRole("link")).toHaveCount(1);
    await expect(section("Pinned").getByRole("link")).toContainText("Grocery");
    await expect(section("Personal").getByRole("link")).toHaveCount(3);
    await expect(section("Family").getByRole("link")).toContainText("Shared shopping list");
  });

  test("shows an empty state on the app list when there are no apps", async ({ page, api }) => {
    void api;
    await page.goto("/apps");
    await expect(page.getByRole("heading", { name: "No apps yet" })).toBeVisible();
  });

  test("shows the account, saves a new name, and explains signing out", async ({ page, api }) => {
    await page.goto("/settings");

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByText("Changes save automatically")).toBeVisible();
    const account = page.locator("section", { has: page.getByRole("heading", { name: "Account" }) });
    await expect(account.getByText("sam@example.com").first()).toBeVisible();
    await expect(account.getByTestId("build-version")).toHaveText("a1b2c3d");
    await expect(account.getByText(/Cloudflare Access/)).toBeVisible();
    await expect(account.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/cdn-cgi/access/logout");

    const name = account.getByLabel("Name");
    await expect(name).toHaveValue("Sam Example");
    await name.fill("  Sam Q. Example ");
    await name.press("Enter");
    await expect(account.getByRole("status")).toHaveText("Saved");
    expect(api.saved).toEqual([{ name: "Sam Q. Example" }]);
    await expect(name).toHaveValue("Sam Q. Example");

    await name.fill("   ");
    await name.blur();
    await expect(account.getByRole("status")).toHaveText("Enter a name of 1 to 80 characters.");
    expect(api.saved).toHaveLength(1);
  });

  test("keeps the typed name when saving it fails, so it can be sent again", async ({ page, api }) => {
    await page.goto("/settings");
    const account = page.locator("section", { has: page.getByRole("heading", { name: "Account" }) });
    const name = account.getByLabel("Name");
    await expect(name).toHaveValue("Sam Example");

    api.failSaves = true;
    await name.fill("A much better name");
    await name.press("Enter");
    await expect(account.getByRole("status")).toHaveText("The name could not be saved. Try again.");
    // What was typed is still there, and the name shown elsewhere is still the saved one.
    await expect(name).toHaveValue("A much better name");
    await expect(account.getByText("Sam Example")).toBeVisible();
    expect(api.saved).toEqual([]);

    // Trying again needs no retyping.
    api.failSaves = false;
    await name.press("Enter");
    await expect(account.getByRole("status")).toHaveText("Saved");
    expect(api.saved).toEqual([{ name: "A much better name" }]);
    await expect(account.getByText("Sam Example")).toHaveCount(0);
  });

  test("the date in the top bar changes at midnight, and after the device slept", async ({ page, api }) => {
    void api;
    // The tests run in UTC (see playwright.config.ts).
    await page.clock.install({ time: new Date("2026-11-10T23:59:30Z") });
    await page.goto("/");
    const bar = page.getByRole("banner");
    await expect(bar.getByText("Tuesday, November 10")).toBeVisible();

    await page.clock.fastForward("01:00");
    await expect(bar.getByText("Wednesday, November 11")).toBeVisible();

    // A sleeping device runs no timers: the clock jumps, and the page is shown again.
    await page.clock.setSystemTime(new Date("2026-11-13T07:00:00Z"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(bar.getByText("Friday, November 13")).toBeVisible();
  });

  test("a long group space name gives way to the app's own name", async ({ page, api }) => {
    const longName = "Lee and Wang families, Shanghai and Vancouver";
    const session = sessionWithApps();
    api.setSession({
      ...session,
      spaces: session.spaces.map((space) => (space.kind === "group" ? { ...space, name: longName } : space)),
    });
    const whole = (element: Element) => element.scrollWidth <= element.clientWidth;

    for (const width of [1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      const card = page.getByTestId("widget-grid").locator("section", { has: page.getByRole("heading", { name: "Grocery" }) });
      const title = card.getByRole("heading", { level: 2 });
      await expect(title).toBeVisible();
      expect(await title.evaluate(whole), `the card title is cut short at ${width}px`).toBe(true);

      // The tag is still there, cut short, and stays inside the card. (The link's hidden text names the group too.)
      const tag = card.getByText(longName, { exact: true });
      await expect(tag).toBeVisible();
      const cardBox = (await card.boundingBox())!;
      const tagBox = (await tag.boundingBox())!;
      expect(tagBox.width).toBeGreaterThanOrEqual(28);
      expect(tagBox.x + tagBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);

      await page.keyboard.press("Control+K");
      const option = page.getByRole("dialog").getByRole("option", { name: /Grocery/ });
      const label = option.getByText("Grocery", { exact: true });
      await expect(label).toBeVisible();
      expect(await label.evaluate(whole), `the switcher label is cut short at ${width}px`).toBe(true);
      const optionBox = (await option.boundingBox())!;
      const noteBox = (await option.getByText(longName).boundingBox())!;
      expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(optionBox.x + optionBox.width);
    }
  });

  test("styles the UI kit, whose components live in the SDK package", async ({ page, api }) => {
    void api;
    await page.goto("/settings");
    // The look of the pressed choice comes from classes that only the kit's own
    // source uses, so it is lost if the stylesheet is built without reading the SDK.
    const pressed = page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" });
    await expect(pressed).toHaveAttribute("aria-pressed", "true");
    const look = await pressed.evaluate((el) => {
      const style = getComputedStyle(el);
      return { radius: style.borderRadius, shadow: style.boxShadow, height: style.height };
    });
    expect(look.radius).toBe("6px");
    expect(look.shadow).not.toBe("none");
    expect(look.height).toBe("28px");
  });

  test("says so when a page does not exist", async ({ page, api }) => {
    void api;
    await page.goto("/no/such/page");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await page.getByRole("link", { name: "Go to the dashboard" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("can be used from the keyboard, with a visible focus ring", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Tab");
    const search = page.getByRole("button", { name: /Search or jump to/ });
    await expect(search).toBeFocused();
    expect(await search.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    expect(await search.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("2px");
  });
});

test.describe("shell on a phone", () => {
  test.use(PHONE);

  test("replaces the sidebar with a tab bar of four 44px targets", async ({ page, api }) => {
    void api;
    await page.goto("/");

    const tabs = page.getByRole("navigation", { name: "Tabs" });
    await expect(tabs).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No widgets yet" })).toBeVisible();

    const targets = [
      tabs.getByRole("link", { name: "Home" }),
      tabs.getByRole("link", { name: "Apps" }),
      tabs.getByRole("button", { name: "Search" }),
      tabs.getByRole("link", { name: "Me", exact: true }),
    ];
    for (const target of targets) {
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

    await expectNothingPastTheEdge(page);
    // The bar sits on the bottom edge.
    const bar = await tabs.boundingBox();
    expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBe(844);
  });

  test("moves between Home, Apps and Me with the tabs", async ({ page, api }) => {
    void api;
    await page.goto("/");
    const tabs = page.getByRole("navigation", { name: "Tabs" });

    await tabs.getByRole("link", { name: "Apps" }).tap();
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Apps" })).toHaveAttribute("aria-current", "page");

    await tabs.getByRole("link", { name: "Me", exact: true }).tap();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();

    // Controls on the page are finger-sized too.
    const search = page.getByRole("banner").getByRole("button", { name: "Search" });
    const box = await search.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    await expectNothingPastTheEdge(page);
  });

  test("keeps every screen inside the edges, with apps, in both languages", async ({ page, api }) => {
    for (const locale of ["en", "zh"] as const) {
      api.setSession(sessionWithApps({ locale, name: "A person with quite a long name indeed" }));
      for (const path of ["/", "/apps", "/settings", "/apps/space-family/grocery", "/no/such/page"]) {
        await page.goto(path);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await expectNothingPastTheEdge(page);
      }

      // The same with the apps this build holds, whose own widgets and page are drawn.
      api.setSession(sessionWithSampleApps({ locale, name: "A person with quite a long name indeed" }));
      api.items[0]!.name = "A thing to do with a name long enough to need more than one line on a phone, in any language";
      for (const path of ["/", `/apps/${FAMILY_SPACE}/checklist`]) {
        await page.goto(path);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await expect(page.getByRole("main").getByRole("checkbox").first()).toBeVisible();
        await expectNothingPastTheEdge(page);
      }
    }
  });

  test("the edge check notices content that is too wide", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.evaluate(() => {
      const wide = document.createElement("div");
      wide.style.width = "2000px";
      wide.style.height = "10px";
      document.querySelector("main#content")?.append(wide);
    });
    // The measure the old check used does not move at all.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(expectNothingPastTheEdge(page)).rejects.toThrow();
  });

  test("the edge check leaves what scrolls inside a named element to it, and that element must fit", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.evaluate(() => {
      const scroller = document.createElement("div");
      scroller.dataset.testid = "sideways";
      scroller.style.overflowX = "auto";
      const wide = document.createElement("div");
      wide.style.width = "2000px";
      wide.style.height = "10px";
      scroller.append(wide);
      document.querySelector("main#content")?.append(scroller);
    });
    await expectNothingPastTheEdge(page, ['[data-testid="sideways"]']);
    // Not named, the same content is a problem; named, but letting its content out, so is the element.
    await expect(expectNothingPastTheEdge(page)).rejects.toThrow();
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="sideways"]');
      if (scroller) scroller.style.overflowX = "visible";
    });
    await expect(expectNothingPastTheEdge(page, ['[data-testid="sideways"]'])).rejects.toThrow();
  });
});
