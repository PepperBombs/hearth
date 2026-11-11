import { expect, test } from "./fixtures.ts";

test("the language toggle switches the interface to Chinese and it survives a reload", async ({ page, api }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "en");

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /中文/ }).click();

  await expect(html).toHaveAttribute("lang", "zh-Hans");
  const sidebar = page.getByRole("navigation", { name: "主导航" });
  await expect(sidebar.getByRole("link", { name: "仪表盘" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "应用" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "设置" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /搜索或跳转/ })).toBeVisible();
  await expect(sidebar.getByRole("heading", { name: "个人" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "仪表盘" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "还没有小组件" })).toBeVisible();
  await expect(page).toHaveTitle("仪表盘 · Hearth");
  await expect(page.getByText("Dashboard")).toHaveCount(0);
  await expect.poll(() => api.saved).toEqual([{ locale: "zh" }]);

  await page.reload();
  await expect(html).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { level: 1, name: "仪表盘" })).toBeVisible();

  // And back again: the toggle is now labelled in English.
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /English/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(html).toHaveAttribute("lang", "en");
});

test("the first language comes from the session, not from the browser", async ({ page, api }) => {
  // The browser asks for English (see playwright.config.ts); the person's saved language is Chinese.
  api.setSession({ ...api.session, user: { ...api.session.user, locale: "zh" } });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("group", { name: "语言" }).getByRole("button", { name: "中文" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("更改会自动保存")).toBeVisible();
  expect(api.saved).toEqual([]);
});

test("Settings switches the language at once", async ({ page, api }) => {
  await page.goto("/settings");
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "外观" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "账户" })).toBeVisible();
  await expect.poll(() => api.saved).toEqual([{ locale: "zh" }]);
});

test("mixed Chinese and English text uses the agreed type settings", async ({ page, api }) => {
  api.setSession({ ...api.session, user: { ...api.session.user, locale: "zh" } });
  await page.goto("/settings");
  await page.getByRole("heading", { level: 1 }).waitFor();
  const style = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return { family: body.fontFamily, size: body.fontSize, autospace: body.getPropertyValue("text-autospace") };
  });
  expect(style.family).toMatch(/^"?Inter"?, system-ui, .*"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif$/);
  expect(style.size).toBe("14px");
  expect(style.autospace).toBe("normal");
  const version = page.getByTestId("build-version");
  expect(await version.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toBe("tabular-nums");
  // No font is fetched from another site.
  const foreign = await page.evaluate((origin) =>
    performance.getEntriesByType("resource").filter((entry) => !entry.name.startsWith(origin)).map((entry) => entry.name),
  new URL(page.url()).origin);
  expect(foreign).toEqual([]);
});
