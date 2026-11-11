/**
 * The Apps page and the settings dialog, against the stand-in server
 * (e2e/fixtures.ts): adding one of the apps this build holds to a space,
 * the person's own switch and pin, removing, moving an app to another
 * space, and the settings form drawn from an app's manifest, in both
 * languages and on a phone. The same is done against the real server in
 * e2e/real-server.spec.ts.
 */
import { FAMILY_SPACE, PERSONAL_SPACE, PHONE, emptySession, expect, ownAFamily, sampleApp, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const spaceCard = (page: Page, name: string) => page.getByRole("main").getByRole("region", { name });

test.describe("the Apps page", () => {
  test("adds an app to a group, asking who else may use it", async ({ page, api }) => {
    const session = emptySession();
    api.setSession({
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
    });
    await page.goto("/apps");

    await spaceCard(page, "Family").getByRole("button", { name: "Add an app" }).click();
    const dialog = page.getByRole("dialog", { name: "Add an app to Family" });
    await expect(dialog.getByRole("radio", { name: /Checklist/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Only me for now" })).toBeChecked();
    await dialog.getByRole("radio", { name: "Everyone can view" }).check();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(api.appChanges).toEqual([`PUT /api/spaces/${FAMILY_SPACE}/apps/checklist {"memberAccess":"view"}`]);
    await expect(spaceCard(page, "Family").getByRole("switch", { name: "Show Checklist in Family" })).toBeChecked();
    // Now on the dashboard too, with its own widget: no rebuild, no reload.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByTestId("widget-grid").getByRole("checkbox", { name: "Water the plants" })).toBeVisible();
  });

  test("pins an app and switches one off, for this person alone", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [sampleApp("feed", PERSONAL_SPACE), sampleApp("checklist", PERSONAL_SPACE)] });
    await page.goto("/");
    const headings = page.getByTestId("widget-grid").getByRole("heading", { level: 2 });
    await expect(headings).toHaveText(["Feed", "Checklist"]);

    await page.goto("/apps");
    const personal = spaceCard(page, "Personal");
    await personal.getByRole("button", { name: "Pin Checklist" }).click();
    await expect(personal.getByRole("button", { name: "Pin Checklist" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Pinned" }).getByRole("link", { name: "Checklist" })).toBeVisible();

    await personal.getByRole("switch", { name: "Show Feed" }).click();
    await expect(personal.getByRole("switch", { name: "Show Feed" })).not.toBeChecked();
    await expect(personal.getByText("Switched off.", { exact: false })).toBeVisible();
    expect(api.appChanges).toEqual([
      `PATCH /api/spaces/${PERSONAL_SPACE}/apps/checklist/me {"pinned":true}`,
      `PATCH /api/spaces/${PERSONAL_SPACE}/apps/feed/me {"enabled":false}`,
    ]);

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(headings).toHaveText(["Checklist"]);
  });

  test("removes an app after asking, for an owner", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [sampleApp("feed", PERSONAL_SPACE)] });
    await page.goto("/apps");
    await spaceCard(page, "Personal").getByRole("button", { name: "Remove Feed" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove Feed?" });
    await expect(dialog.getByText(/Its data is kept/)).toBeVisible();
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toBeHidden();
    await expect(spaceCard(page, "Personal").getByText("No personal apps yet.")).toBeVisible();
    expect(api.appChanges).toEqual([`DELETE /api/spaces/${PERSONAL_SPACE}/apps/feed null`]);
  });

  test("moves an app out of a group into the owner's own space and back, asking who may use it there", async ({ page, api }) => {
    ownAFamily(api);
    await page.goto("/apps");

    await spaceCard(page, "Family").getByRole("button", { name: "Move Checklist in Family", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Move Checklist in Family to another space" });
    await expect(dialog.getByRole("radio", { name: /Personal/ })).toBeChecked();
    await expect(dialog.getByText(/Anyone here who is not in that space loses it/)).toBeVisible();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog).toBeHidden();

    // It is in the personal space now, which says so and has the focus.
    const personal = spaceCard(page, "Personal");
    await expect(personal.getByRole("switch", { name: "Show Checklist" })).toBeChecked();
    await expect(personal.getByText("Checklist was moved here.")).toBeFocused();
    await expect(spaceCard(page, "Family").getByText("No apps in this space yet.")).toBeVisible();

    // Back into the family, this time for everyone to view.
    await personal.getByRole("button", { name: "Move Checklist", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Move Checklist to another space" });
    await expect(dialog.getByRole("radio", { name: /Family/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Only me for now" })).toBeChecked();
    await dialog.getByRole("radio", { name: "Everyone can view" }).check();
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(spaceCard(page, "Family").getByText("Checklist was moved here.")).toBeFocused();

    expect(api.appChanges).toEqual([
      `POST /api/spaces/${FAMILY_SPACE}/apps/checklist/move {"toSpaceId":"${PERSONAL_SPACE}"}`,
      `POST /api/spaces/${PERSONAL_SPACE}/apps/checklist/move {"toSpaceId":"${FAMILY_SPACE}","memberAccess":"view"}`,
    ]);
    // The table of who can use what in Settings has it again, with what was chosen for everyone.
    await page.getByRole("link", { name: "Settings" }).click();
    const table = spaceCard(page, "Family").getByRole("table", { name: "Who can use each app" });
    await expect(table.getByRole("combobox", { name: "Everyone's access to Checklist" })).toHaveValue("view");
  });

  test("says when an app cannot be moved, and keeps the dialog open", async ({ page, api }) => {
    ownAFamily(api);
    api.setSession({ ...api.session, apps: [sampleApp("checklist", FAMILY_SPACE), sampleApp("checklist", PERSONAL_SPACE)] });
    // The personal space has the checklist, so it has nowhere to go; the family's could go to the personal space ...
    await page.goto("/apps");
    await expect(spaceCard(page, "Personal").getByRole("button", { name: /^Move/ })).toHaveCount(0);
    await expect(spaceCard(page, "Family").getByRole("button", { name: /^Move/ })).toHaveCount(0);

    // ... but not when the server holds one there from before that the session does not list.
    api.setSession({ ...api.session, apps: [sampleApp("checklist", FAMILY_SPACE)] });
    api.appFailure = { status: 409, code: "conflict", message: "Sample failure" };
    await page.reload();
    await spaceCard(page, "Family").getByRole("button", { name: "Move Checklist in Family", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Move Checklist in Family to another space" });
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog.getByText("The app cannot be moved there. That space may have it already, or have kept its data from before.")).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(spaceCard(page, "Family").getByRole("switch", { name: "Show Checklist in Family" })).toBeVisible();
  });

  test("moves an app in Chinese", async ({ page, api }) => {
    ownAFamily(api, { locale: "zh" });
    await page.goto("/apps");
    await spaceCard(page, "Family").getByRole("button", { name: "移动Family的清单" }).click();
    const dialog = page.getByRole("dialog", { name: "把Family的清单移到另一个空间" });
    await expect(dialog.getByRole("group", { name: "移到" }).getByRole("radio", { name: /个人/ })).toBeChecked();
    await expect(dialog.getByText(/它的一切都会一起移过去/)).toBeVisible();
    await dialog.getByRole("button", { name: "移动", exact: true }).click();
    await expect(spaceCard(page, "个人").getByText("清单已移到这里。")).toBeFocused();
  });

  test.describe("on a phone", () => {
    test.use(PHONE);

    test("moves an app in a dialog that fits the screen, with choices large enough to tap", async ({ page, api }) => {
      ownAFamily(api);
      api.setSession({ ...api.session, apps: [sampleApp("feed", PERSONAL_SPACE)] });
      await page.goto("/apps");
      const move = spaceCard(page, "Personal").getByRole("button", { name: "Move Feed", exact: true });
      expect((await move.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await move.tap();
      const dialog = page.getByRole("dialog", { name: "Move Feed to another space" });
      // The dialog opens with a slight zoom; measure it once that is over.
      await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
      expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(390);
      for (const name of ["Only me for now", "Everyone can view", "Everyone can edit"]) {
        const box = await dialog.locator("label", { has: page.getByRole("radio", { name }) }).boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      await dialog.getByRole("radio", { name: "Everyone can edit" }).tap();
      await dialog.getByRole("button", { name: "Move", exact: true }).tap();
      await expect(dialog).toBeHidden();
      await expect(spaceCard(page, "Family").getByText("Feed was moved here.")).toBeVisible();
      expect(api.appChanges).toEqual([`POST /api/spaces/${PERSONAL_SPACE}/apps/feed/move {"toSpaceId":"${FAMILY_SPACE}","memberAccess":"edit"}`]);
    });

    test("fits the screen, with every control large enough to tap", async ({ page, api }) => {
      api.setSession({ ...emptySession(), apps: [sampleApp("checklist", PERSONAL_SPACE), sampleApp("feed", PERSONAL_SPACE)] });
      await page.goto("/apps");
      const personal = spaceCard(page, "Personal");
      await expect(personal.getByRole("switch", { name: "Show Checklist" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      for (const name of ["Pin Checklist", "Settings of Checklist", "Remove Checklist"]) {
        const box = await personal.getByRole("button", { name }).boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

test.describe("the settings dialog", () => {
  test("changes a setting in English and then in Chinese, sending only what changed", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [sampleApp("checklist", PERSONAL_SPACE)] });
    await page.goto(`/apps/${PERSONAL_SPACE}/checklist`);
    await expect(page.getByRole("main").getByRole("checkbox", { name: "Return the library books" })).toBeVisible();

    await page.getByRole("banner").getByRole("button", { name: "Settings of Checklist" }).click();
    let dialog = page.getByRole("dialog", { name: "Checklist settings" });
    await dialog.getByRole("switch", { name: "Hide ticked items" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    // The page reads the new setting: ticked items are hidden.
    await expect(page.getByRole("main").getByRole("checkbox", { name: "Return the library books" })).toBeHidden();

    await page.getByRole("button", { name: /Switch language/ }).click();
    await page.getByRole("banner").getByRole("button", { name: "清单的设置" }).click();
    dialog = page.getByRole("dialog", { name: "清单设置" });
    await expect(dialog.getByRole("group", { name: "对这个空间" })).toBeVisible();
    const sections = dialog.getByRole("group", { name: "分组" });
    await sections.getByRole("textbox", { name: "分组的新条目" }).fill("花园");
    await sections.getByRole("button", { name: "添加" }).click();
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();

    expect(api.appChanges).toEqual([
      'PATCH checklist/settings {"user":{"hideDone":true}}',
      'PATCH checklist/settings {"space":{"sections":["花园"]}}',
    ]);
  });

  test("shows the space's settings to a viewer without letting them change them", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [sampleApp("checklist", PERSONAL_SPACE, { access: "view" })] });
    await page.goto("/");
    await page.getByRole("button", { name: "Settings of Checklist" }).click();
    const dialog = page.getByRole("dialog", { name: "Checklist settings" });
    await expect(dialog.getByText("You may only view this app, so you cannot change these.")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "New entry in Sections" })).toHaveCount(0);
    await expect(dialog.getByRole("switch", { name: "Hide ticked items" })).toBeEnabled();
  });

  test.describe("on a phone", () => {
    test.use(PHONE);

    test("fits the screen and saves", async ({ page, api }) => {
      api.setSession({ ...emptySession(), apps: [sampleApp("feed", PERSONAL_SPACE)] });
      await page.goto("/");
      await page.getByRole("button", { name: "Settings of Feed" }).tap();
      const dialog = page.getByRole("dialog", { name: "Feed settings" });
      await dialog.getByRole("button", { name: "Sport" }).tap();
      const box = await dialog.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(390);
      await dialog.getByRole("button", { name: "Save" }).tap();
      await expect(dialog).toBeHidden();
      await expect(page.getByText("Following 1 topics")).toBeVisible();
    });
  });
});
