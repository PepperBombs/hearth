import { PHONE, expect, sessionWithApps, test } from "./fixtures.ts";

test.describe("quick switcher", () => {
  test("Ctrl+K opens it, typing filters, and Enter goes to the page", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1, name: "Dashboard" }).waitFor();

    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("combobox");
    await expect(input).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveText([/Dashboard/, /Apps/, /Settings/, /Switch to dark mode/, /Use the device theme/, /中文/]);

    await page.keyboard.type("sett");
    await expect(dialog.getByRole("option")).toHaveText([/Settings/]);
    await expect(dialog.getByRole("option", { name: /Settings/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("Cmd+K opens it too, and the same keys close it", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Meta+K");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Meta+K");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("the sidebar's search button opens it, and Escape hands focus back", async ({ page, api }) => {
    void api;
    await page.goto("/");
    const search = page.getByRole("button", { name: /Search or jump to/ });
    await search.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(search).toBeFocused();
  });

  test("keeps keyboard focus inside while open", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      const where = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return "browser";
        return active.closest("dialog") ? "dialog" : "page";
      });
      expect(where).not.toBe("page");
    }
    // The page behind cannot be reached with the pointer either: a click where the Settings link is lands on the dialog.
    const target = await page.getByRole("link", { name: "Settings" }).evaluate((link) => {
      const box = link.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.tagName;
    });
    expect(target).toBe("DIALOG");
  });

  test("arrow keys move through the results and a click chooses one", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("option", { name: /Dashboard/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("option", { name: /Apps/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/apps$/);

    await page.keyboard.press("Control+K");
    await page.getByRole("dialog").getByRole("option", { name: /Dashboard/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("finds pages and apps by their Chinese names while the interface is English", async ({ page, api }) => {
    api.setSession(sessionWithApps());
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("combobox");

    await input.fill("购物");
    await expect(dialog.getByRole("option")).toHaveText([/Grocery.*Family/]);
    await input.fill("设置");
    await expect(dialog.getByRole("option")).toHaveText([/Settings/]);
    await input.fill("没有这个");
    await expect(dialog.getByText("Nothing matches. Try another word.")).toBeVisible();

    await input.fill("笔记");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/apps\/space-personal\/notes$/);
    await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  });

  test("does not open a result when Enter only confirms Chinese input", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("combobox");
    await expect(input).toBeFocused();

    // Drive a real input-method composition through the browser. The text being
    // composed must already match something: with an empty list Enter does
    // nothing either way, and this test could not fail.
    const client = await page.context().newCDPSession(page);
    await client.send("Input.imeSetComposition", { text: "设置", selectionStart: 2, selectionEnd: 2 });
    await expect(input).toHaveValue("设置");
    await expect(dialog.getByRole("option").first()).toContainText("Settings");
    // The key press that picks the candidate, as the browser reports it mid-composition.
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    await client.send("Input.insertText", { text: "设置" });
    await expect(input).toHaveValue("设置");
    await expect(dialog.getByRole("option")).toHaveText([/Settings/]);
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("runs actions: switch theme and switch language", async ({ page, api }) => {
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();

    await page.keyboard.press("Control+K");
    await page.keyboard.type("主题");
    await expect(page.getByRole("dialog").getByRole("option").first()).toContainText("Switch to dark mode");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.keyboard.press("Control+K");
    await page.keyboard.type("language");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "仪表盘" })).toBeVisible();
    await expect.poll(() => api.saved).toEqual([{ theme: "dark" }, { locale: "zh" }]);

    // Now in Chinese, with the wording to match.
    await page.keyboard.press("Control+K");
    await expect(page.getByRole("dialog", { name: "快速切换" }).getByRole("option")).toHaveText([
      /仪表盘/,
      /应用/,
      /设置/,
      /切换到浅色模式/,
      /主题跟随系统/,
      /English/,
    ]);
  });
});

test.describe("quick switcher on a phone", () => {
  test.use(PHONE);

  test("the Search tab opens it full screen", async ({ page, api }) => {
    void api;
    await page.goto("/");
    await page.getByRole("navigation", { name: "Tabs" }).getByRole("button", { name: "Search" }).tap();

    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await expect(dialog.getByRole("combobox")).toBeFocused();

    const close = dialog.getByRole("button", { name: "Close search" });
    const box = await close.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);

    await dialog.getByRole("option", { name: /Settings/ }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("the search button in the top bar opens it, and the close button closes it", async ({ page, api }) => {
    void api;
    await page.goto("/apps");
    await page.getByRole("banner").getByRole("button", { name: "Search" }).tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close search" }).tap();
    await expect(dialog).toBeHidden();
  });
});
