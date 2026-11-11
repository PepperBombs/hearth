import { expect, test } from "./fixtures.ts";

const LIGHT_BG = "rgb(241, 244, 249)";
const DARK_BG = "rgb(16, 20, 27)";
const background = () => getComputedStyle(document.body).backgroundColor;

test("the theme toggle switches to dark, saves it, and it survives a reload", async ({ page, api }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(background)).toBe(LIGHT_BG);

  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(background)).toBe(DARK_BG);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#1a2029");
  await expect(page.getByRole("button", { name: "Light mode" })).toBeVisible();
  await expect.poll(() => api.saved).toEqual([{ theme: "dark" }]);
  expect(await page.evaluate(() => localStorage.getItem("hearth.theme"))).toBe("dark");

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Light mode" })).toBeVisible();
  expect(await page.evaluate(background)).toBe(DARK_BG);

  await page.getByRole("button", { name: "Light mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect.poll(() => api.saved).toEqual([{ theme: "dark" }, { theme: "light" }]);
});

test("the remembered theme is applied before the app's script runs", async ({ page, api }) => {
  void api;
  await page.addInitScript(() => localStorage.setItem("hearth.theme", "dark"));
  // Hold the app back entirely: only index.html and theme-init.js get through.
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(background)).toBe(DARK_BG);
  expect(await page.locator("#root").innerHTML()).toBe("");
});

test("Settings offers light, dark and system, and system follows the device live", async ({ page, api }) => {
  await page.goto("/settings");
  const html = page.locator("html");
  const theme = page.getByRole("group", { name: "Theme" });
  await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");

  await theme.getByRole("button", { name: "Dark" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");

  await theme.getByRole("button", { name: "System" }).click();
  await expect(theme.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect.poll(() => api.saved).toEqual([{ theme: "dark" }, { theme: "system" }]);

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");

  // Still "system" after a reload, on a device that is now dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the theme stored on the server wins over what this browser remembered", async ({ page, api }) => {
  api.setSession({ ...api.session, user: { ...api.session.user, theme: "dark" } });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) localStorage.setItem("hearth.theme", "light");
    sessionStorage.setItem("seeded", "1");
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("hearth.theme"))).toBe("dark");
  expect(api.saved).toEqual([]);
});

test("a failed save is reported and can be sent again", async ({ page, api }) => {
  await page.goto("/");
  api.failSaves = true;
  await page.getByRole("button", { name: "Dark mode" }).click();
  // The choice still applies on this device.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Your choice could not be saved to the server.")).toBeVisible();

  api.failSaves = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Your choice could not be saved to the server.")).toBeHidden();
  expect(api.saved).toEqual([{ theme: "dark" }]);
});

test("a choice that could not be saved is kept on this device and sent again on the next visit", async ({ page, api }) => {
  // The server has "light" stored, and keeps it: the save fails.
  await page.goto("/");
  api.failSaves = true;
  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(page.getByText("Your choice could not be saved to the server. It is still applied on this device.")).toBeVisible();
  expect(api.session.user.theme).toBe("light");

  // Still dark after a reload, as the message promised, although the server says light.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Light mode" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("hearth.theme"))).toBe("dark");
  expect(api.saved).toEqual([]);

  // Once the server takes it, it is sent without being asked for, exactly once.
  api.failSaves = false;
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => api.saved).toEqual([{ theme: "dark" }]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hearth.unsaved"))).toBeNull();
  await expect(page.getByText("Your choice could not be saved to the server.")).toBeHidden();

  // From here on the server's value wins again, for example after a change on another device.
  api.setSession({ ...api.session, user: { ...api.session.user, theme: "light" } });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(api.saved).toEqual([{ theme: "dark" }]);
});

test("motion is switched off for people who ask for less of it", async ({ page, api }) => {
  void api;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
