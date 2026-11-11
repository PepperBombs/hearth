/**
 * Not a test: takes screenshots for looking over the design.
 * Skipped unless HEARTH_SHOTS_DIR names a folder to write to, for example
 *   HEARTH_SHOTS_DIR=/tmp/hearth-shots pnpm e2e screenshots
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { FAMILY_SPACE, ownAFamily, sessionWithApps, sessionWithSampleApps, test } from "./fixtures.ts";

/** Animations are run to their end first, so a dialog is never caught half faded in. */
const shot = (page: Page, path: string) => page.screenshot({ path, animations: "disabled" });

const dir = process.env.HEARTH_SHOTS_DIR;
const sizes = [
  { name: "1440x900", viewport: { width: 1440, height: 900 }, isMobile: false },
  { name: "390x844", viewport: { width: 390, height: 844 }, isMobile: true },
] as const;
const themes = ["light", "dark"] as const;
const locales = ["en", "zh"] as const;

test.describe("screenshots", () => {
  test.skip(!dir, "Set HEARTH_SHOTS_DIR to take screenshots.");

  for (const size of sizes) {
    for (const theme of themes) {
      for (const locale of locales) {
        test.describe(`${size.name} ${theme} ${locale}`, () => {
          test.use({ viewport: size.viewport, isMobile: size.isMobile, hasTouch: size.isMobile, deviceScaleFactor: 2 });
          const file = (screen: string) => join(dir ?? ".", `${screen}-${size.name}-${theme}-${locale}.png`);

          test("empty shell", async ({ page, api }) => {
            api.setSession({ ...api.session, user: { ...api.session.user, theme, locale } });
            await page.goto("/");
            await page.getByRole("heading", { level: 1 }).waitFor();
            await shot(page, file("dashboard"));
            await page.goto("/settings");
            await page.getByRole("heading", { level: 1 }).waitFor();
            await shot(page, file("settings"));
            await page.goto("/apps");
            await page.getByRole("heading", { level: 1 }).waitFor();
            await shot(page, file("apps"));
            await page.goto("/");
            await page.getByRole("heading", { level: 1 }).waitFor();
            await page.keyboard.press("Control+K");
            await page.getByRole("dialog").waitFor();
            await shot(page, file("switcher"));
            await page.getByRole("combobox").fill(locale === "zh" ? "深色" : "zzz");
            await shot(page, file("switcher-typed"));
          });

          test("with sample apps", async ({ page, api }) => {
            api.setSession(sessionWithApps({ theme, locale }));
            await page.goto("/");
            await page.getByRole("heading", { level: 1 }).waitFor();
            await shot(page, file("sample-dashboard"));
            await page.goto("/apps");
            await page.getByRole("heading", { level: 1 }).waitFor();
            await shot(page, file("sample-apps"));
            await page.keyboard.press("Control+K");
            await page.getByRole("dialog").waitFor();
            await page.getByRole("combobox").fill(locale === "zh" ? "购物" : "gro");
            await shot(page, file("sample-switcher"));
          });

          test("with the apps this build holds", async ({ page, api }) => {
            api.setSession(sessionWithSampleApps({ theme, locale }));
            await page.goto("/");
            await page.getByTestId("widget-grid").getByRole("checkbox").first().waitFor();
            await shot(page, file("widgets"));
            await page.goto(`/apps/${FAMILY_SPACE}/checklist`);
            await page.getByRole("main").getByRole("checkbox").first().waitFor();
            await shot(page, file("app-page"));
            await page.getByRole("banner").getByRole("button", { name: /Checklist|清单/ }).click();
            await page.getByRole("dialog").getByRole("switch").waitFor();
            await shot(page, file("app-settings"));
            await page.keyboard.press("Escape");
            await page.goto("/apps");
            await page.getByRole("main").getByRole("switch").first().waitFor();
            await shot(page, file("apps-manage"));
            await page.getByRole("main").getByRole("button", { name: /Add an app|添加应用/ }).first().click();
            await page.getByRole("dialog").getByRole("radio").first().waitFor();
            await shot(page, file("apps-add"));
            await page.keyboard.press("Escape");
            await page.getByRole("main").getByRole("button", { name: /^(Move Feed|移动动态)$/ }).click();
            await page.getByRole("dialog").getByRole("radio").first().waitFor();
            await shot(page, file("apps-move"));
            await page.getByRole("dialog").getByRole("button", { name: /^(Move|移动)$/ }).click();
            await page.getByRole("main").getByText(/Feed was moved here|动态已移到这里/).waitFor();
            await shot(page, file("apps-moved"));
          });

          test("a family in Settings", async ({ page, api }) => {
            ownAFamily(api, { theme, locale });
            await page.goto("/settings");
            const family = page.getByRole("main").getByRole("region", { name: "Family" });
            await family.getByRole("table").waitFor();
            await family.screenshot({ path: file("group-card"), animations: "disabled" });
            await family.getByRole("button", { name: /Add a person|添加成员/ }).click();
            await page.getByRole("dialog").getByRole("textbox").waitFor();
            await shot(page, file("group-add"));
            await page.keyboard.press("Escape");
            await family.getByRole("button", { name: /Lin Example/ }).click();
            await page.getByRole("dialog").getByRole("switch").waitFor();
            await shot(page, file("group-member"));
          });
        });
      }
    }
  }

  test("screens without a session", async ({ page, api }) => {
    api.failSession(403, "not_a_member");
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await shot(page, join(dir ?? ".", "not-a-member-1440x900-light-en.png"));
    api.failSession(500, "internal");
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await shot(page, join(dir ?? ".", "error-1440x900-light-en.png"));
    api.setSession(api.session);
    await page.goto("/nowhere");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await shot(page, join(dir ?? ".", "not-found-1440x900-light-en.png"));
  });
});
