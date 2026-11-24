/**
 * The Apps page and the settings dialog, against the stand-in server
 * (e2e/fixtures.ts): adding one of the built-in apps to a space or bringing
 * back one it removed, the person's own switch and pin, removing, moving an
 * app to another space, the space's removed apps, brought back or deleted
 * for good once their name is typed, and the settings form drawn from what
 * an app declares, in both languages and on a phone. The same is done against the
 * real server, with the built-in apps Hearth ships, in e2e/real-server.spec.ts.
 */
import {
  FAMILY_SPACE,
  PERSONAL_SPACE,
  PHONE,
  builtInApp,
  emptySession,
  expect,
  expectNothingPastTheEdge,
  ownAFamily,
  sandbox,
  sessionWithBuiltInApps,
  test,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";
import type { InstalledApp } from "../packages/shared/src/index.ts";
import type { FakeApi } from "./fixtures.ts";

const spaceCard = (page: Page, name: string) => page.getByRole("main").getByRole("region", { name });

/**
 * The family of `ownAFamily`, which removed two apps and kept their data: a
 * ledger made in the chat, with a name of its maker's in both languages,
 * and the built-in feed.
 */
function familyWithRemovedApps(api: FakeApi, locale: "en" | "zh" = "en"): void {
  ownAFamily(api, { locale });
  const removed = { hasCode: true, removedAt: "2026-11-01T08:00:00.000Z", memberAccess: "view", members: {}, assistant: true } as const;
  const ledger: InstalledApp = { ...removed, id: "m-ledger", rowCount: 12, name: { en: "Ledger", zh: "Ledger" }, icon: "wallet", color: "amber" };
  const feed: InstalledApp = { ...removed, id: "m-feed", template: "feed", rowCount: 1, name: { en: "Feed", zh: "动态" }, icon: "trending-up", color: "purple" };
  api.groups[FAMILY_SPACE]!.apps.push(ledger, feed);
}

test.describe("the Apps page", () => {
  test("adds a built-in app to a group, asking who else may use it", async ({ page, api }) => {
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
          assistant: "none",
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
    // An app that fetches from a host says which, under its description.
    const feed = dialog.locator("label", { has: page.getByRole("radio", { name: /Feed/ }) });
    await expect(feed.getByText("Fetches data from feeds.example.com on its own.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Only me for now" })).toBeChecked();
    await dialog.getByRole("radio", { name: "Everyone can view" }).check();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();

    // The built-in app is named, and the family gets an app of its own made from it.
    expect(api.appChanges).toEqual([`POST /api/spaces/${FAMILY_SPACE}/catalog/checklist {"memberAccess":"view"}`]);
    await expect(spaceCard(page, "Family").getByRole("switch", { name: "Show Checklist in Family" })).toBeChecked();
    // Now on the dashboard too, its page drawn in its card, in the sandbox: no rebuild, no reload.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(sandbox(page, "m-checklist").getByRole("heading", { name: "Checklist" })).toBeVisible();
    await expect(sandbox(page, "m-checklist").locator("body")).toHaveAttribute("data-view", "card");
  });

  test("says, before an app the family removed is added again, that its data comes back with it", async ({ page, api }) => {
    ownAFamily(api);
    api.groups[FAMILY_SPACE]!.apps.push({
      id: "m-feed",
      template: "feed",
      hasCode: true,
      removedAt: "2026-11-01T08:00:00.000Z",
      rowCount: 4,
      memberAccess: "view",
      members: {},
      assistant: true,
    });
    await page.goto("/apps");

    // The family has the checklist, so the feed is the one offered.
    await spaceCard(page, "Family").getByRole("button", { name: "Add an app" }).click();
    const dialog = page.getByRole("dialog", { name: "Add an app to Family" });
    await expect(dialog.getByRole("radio", { name: /Feed/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /Checklist/ })).toHaveCount(0);
    await expect(dialog.getByText("Removed earlier: adding it again brings back its data, 4 saved entries.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Only me for now" })).toBeChecked();
    await dialog.getByRole("button", { name: "Bring back" }).click();
    await expect(dialog).toBeHidden();
    expect(api.appChanges).toEqual([`POST /api/spaces/${FAMILY_SPACE}/catalog/feed {"memberAccess":"none"}`]);
    await expect(spaceCard(page, "Family").getByRole("switch", { name: "Show Feed in Family" })).toBeChecked();

    // Back for the owners alone: the family's table in Settings says so.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
    const table = spaceCard(page, "Family").getByRole("table", { name: "Who can use each app" });
    await expect(table.getByRole("combobox", { name: "Everyone's access to Feed" })).toHaveValue("none");
  });

  test("pins an app and switches one off, for this person alone", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [builtInApp("feed", PERSONAL_SPACE), builtInApp("checklist", PERSONAL_SPACE)] });
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
      `PATCH /api/spaces/${PERSONAL_SPACE}/apps/m-checklist/me {"pinned":true}`,
      `PATCH /api/spaces/${PERSONAL_SPACE}/apps/m-feed/me {"enabled":false}`,
    ]);

    // The dashboard draws the pinned app first, and no page at all of the one switched off.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(headings).toHaveText(["Checklist"]);
    await expect(sandbox(page, "m-checklist").getByRole("heading", { name: "Checklist" })).toBeVisible();
    await expect(page.locator('iframe[data-made-app="m-feed"]')).toHaveCount(0);
  });

  test("removes an app after asking, for an owner", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [builtInApp("feed", PERSONAL_SPACE)] });
    await page.goto("/apps");
    await spaceCard(page, "Personal").getByRole("button", { name: "Remove Feed" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove Feed?" });
    await expect(dialog.getByText(/Its data is kept/)).toBeVisible();
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toBeHidden();
    await expect(spaceCard(page, "Personal").getByText("No personal apps yet.")).toBeVisible();
    expect(api.appChanges).toEqual([`DELETE /api/spaces/${PERSONAL_SPACE}/apps/m-feed null`]);
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
      `POST /api/spaces/${FAMILY_SPACE}/apps/m-checklist/move {"toSpaceId":"${PERSONAL_SPACE}"}`,
      `POST /api/spaces/${PERSONAL_SPACE}/apps/m-checklist/move {"toSpaceId":"${FAMILY_SPACE}","memberAccess":"view"}`,
    ]);
    // The table of who can use what in Settings has it again, with what was chosen for everyone.
    await page.getByRole("link", { name: "Settings" }).click();
    const table = spaceCard(page, "Family").getByRole("table", { name: "Who can use each app" });
    await expect(table.getByRole("combobox", { name: "Everyone's access to Checklist" })).toHaveValue("view");
  });

  test("says when an app cannot be moved, and keeps the dialog open", async ({ page, api }) => {
    ownAFamily(api);
    // The server turns the move down, as it does for a space that has the app, or had it and kept its data.
    api.appFailure = { status: 409, code: "conflict", message: "Sample failure" };
    await page.goto("/apps");
    await spaceCard(page, "Family").getByRole("button", { name: "Move Checklist in Family", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Move Checklist in Family to another space" });
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog.getByText("The app cannot be moved there. That space may have it already, or have kept its data from before.")).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(spaceCard(page, "Family").getByRole("switch", { name: "Show Checklist in Family" })).toBeVisible();
    expect(api.appChanges).toEqual([`POST /api/spaces/${FAMILY_SPACE}/apps/m-checklist/move {"toSpaceId":"${PERSONAL_SPACE}"}`]);
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

  test("lists the apps a space removed, for its owners, and brings one back with what it held", async ({ page, api }) => {
    familyWithRemovedApps(api);
    await page.goto("/apps");
    const family = spaceCard(page, "Family");
    const removed = family.getByRole("list", { name: "Removed apps" });
    await expect(removed.getByRole("listitem")).toHaveText([/Ledger\s*12 entries/, /Feed\s*1 entry/]);
    // The personal space removed nothing, so it shows no such list.
    await expect(spaceCard(page, "Personal").getByRole("list", { name: "Removed apps" })).toHaveCount(0);

    // An app made in the chat comes back from here, asking who else may use it, "only me for now" first.
    await family.getByRole("button", { name: "Bring back Ledger in Family" }).click();
    const dialog = page.getByRole("dialog", { name: "Bring back Ledger in Family?" });
    await expect(dialog.getByText("It comes back with its data, 12 saved entries, and its settings.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Only me for now" })).toBeChecked();
    await dialog.getByRole("radio", { name: "Everyone can edit" }).check();
    await dialog.getByRole("button", { name: "Bring back", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(family.getByText("Ledger is back.")).toBeFocused();
    await expect(family.getByRole("switch", { name: "Show Ledger in Family" })).toBeChecked();
    await expect(removed.getByRole("listitem")).toHaveText([/Feed/]);
    expect(api.appChanges).toEqual([`PUT /api/spaces/${FAMILY_SPACE}/apps/m-ledger {"memberAccess":"edit"}`]);
  });

  test("deletes a removed app for good only once its name is typed, and says it cannot be undone", async ({ page, api }) => {
    familyWithRemovedApps(api);
    await page.goto("/apps");
    const family = spaceCard(page, "Family");
    await family.getByRole("button", { name: "Delete permanently: Ledger in Family" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Ledger for good?" });
    await expect(dialog.getByText("Its 12 entries, its settings and its versions are deleted for everyone in Family. This cannot be undone.")).toBeVisible();
    const box = dialog.getByRole("textbox", { name: "Type “Ledger” to confirm" });
    const confirm = dialog.getByRole("button", { name: "Delete", exact: true });
    await expect(confirm).toBeDisabled();
    for (const typed of ["Ledge", "ledger", "Ledger s"]) {
      await box.fill(typed);
      await expect(confirm).toBeDisabled();
    }
    // Cancel deletes nothing, and the box starts empty when the dialog opens again.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(api.appChanges).toEqual([]);
    await family.getByRole("button", { name: "Delete permanently: Ledger in Family" }).click();
    await expect(box).toHaveValue("");

    await box.fill(" Ledger ");
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(family.getByText("Ledger was deleted.")).toBeFocused();
    await expect(family.getByRole("list", { name: "Removed apps" }).getByRole("listitem")).toHaveText([/Feed/]);
    expect(api.appChanges).toEqual([`DELETE /api/spaces/${FAMILY_SPACE}/apps/m-ledger/data {"confirm":"Ledger"}`]);
  });

  test("deletes an app in use for good from its Remove dialog, and says why the server refused", async ({ page, api }) => {
    ownAFamily(api);
    await page.goto("/apps");
    const family = spaceCard(page, "Family");
    await family.getByRole("button", { name: "Remove Checklist in Family" }).click();
    const remove = page.getByRole("dialog", { name: "Remove Checklist in Family?" });
    // Removing keeps its data, and it can be brought back; deleting it for good is offered beside that.
    await expect(remove.getByText(/Its data is kept: bring it back from Removed apps on this page, or add it again/)).toBeVisible();
    await remove.getByRole("button", { name: "Delete permanently" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Checklist for good?" });
    await expect(dialog.getByText("Its 3 entries, its settings and its versions are deleted for everyone in Family. This cannot be undone.")).toBeVisible();
    await dialog.getByRole("textbox", { name: "Type “Checklist” to confirm" }).fill("Checklist");

    // The server checks again: someone who is no longer an owner is told so, and nothing is deleted.
    api.appFailure = { status: 403, code: "forbidden", message: "Sample failure" };
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.getByText("Only an owner of this space can delete an app.")).toBeVisible();
    api.appFailure = null;
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(family.getByText("Checklist was deleted.")).toBeFocused();
    await expect(family.getByText("No apps in this space yet.")).toBeVisible();
    // Gone for good: not among the removed apps either.
    await expect(family.getByRole("list", { name: "Removed apps" })).toHaveCount(0);
    expect(api.appChanges).toEqual([
      `DELETE /api/spaces/${FAMILY_SPACE}/apps/m-checklist/data {"confirm":"Checklist"}`,
      `DELETE /api/spaces/${FAMILY_SPACE}/apps/m-checklist/data {"confirm":"Checklist"}`,
    ]);
  });

  test("a removed app made in the chat is listed after it is removed, and comes back from there", async ({ page, api }) => {
    // Removing it is the only way out of the dashboard for an app made in the chat: Removed apps is the way back.
    api.setSession({ ...emptySession(), apps: [builtInApp("feed", PERSONAL_SPACE, { id: "m-notes", template: undefined, name: { en: "Notes", zh: "笔记" } })] });
    await page.goto("/apps");
    const personal = spaceCard(page, "Personal");
    await personal.getByRole("button", { name: "Remove Notes" }).click();
    const remove = page.getByRole("dialog", { name: "Remove Notes?" });
    await expect(remove.getByText("It disappears for everyone in this space. Its data is kept: an owner can bring it back from Removed apps on this page.")).toBeVisible();
    await remove.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(remove).toBeHidden();
    await expect(personal.getByRole("list", { name: "Removed apps" }).getByRole("listitem")).toHaveText([/Notes\s*No entries/]);

    // In a personal space there is nobody else to ask about.
    await personal.getByRole("button", { name: "Bring back Notes" }).click();
    const back = page.getByRole("dialog", { name: "Bring back Notes?" });
    await expect(back.getByText("It comes back with its settings.")).toBeVisible();
    await expect(back.getByRole("radio")).toHaveCount(0);
    await back.getByRole("button", { name: "Bring back", exact: true }).click();
    await expect(personal.getByText("Notes is back.")).toBeFocused();
    await expect(personal.getByRole("switch", { name: "Show Notes" })).toBeChecked();
    await expect(personal.getByRole("list", { name: "Removed apps" })).toHaveCount(0);
    expect(api.appChanges).toEqual([`DELETE /api/spaces/${PERSONAL_SPACE}/apps/m-notes null`, `PUT /api/spaces/${PERSONAL_SPACE}/apps/m-notes {}`]);
  });

  test("a member sees no removed apps, and cannot delete or bring back any", async ({ page, api }) => {
    familyWithRemovedApps(api);
    api.setSession({ ...api.session, spaces: api.session.spaces.map((space) => (space.id === FAMILY_SPACE ? { ...space, role: "member" as const } : space)) });
    await page.goto("/apps");
    const family = spaceCard(page, "Family");
    await expect(family.getByRole("switch", { name: "Show Checklist in Family" })).toBeVisible();
    await expect(family.getByRole("list", { name: "Removed apps" })).toHaveCount(0);
    await expect(family.getByRole("button", { name: /^(Bring back|Delete permanently|Remove)/ })).toHaveCount(0);
  });

  test("the removed apps and deleting one for good, in Chinese", async ({ page, api }) => {
    familyWithRemovedApps(api, "zh");
    await page.goto("/apps");
    const family = spaceCard(page, "Family");
    const removed = family.getByRole("list", { name: "已移除的应用" });
    await expect(removed.getByRole("listitem")).toHaveText([/Ledger\s*12 条数据/, /动态\s*1 条数据/]);
    await family.getByRole("button", { name: "永久删除Family的动态" }).click();
    const dialog = page.getByRole("dialog", { name: "要永久删除动态吗？" });
    await expect(dialog.getByText("它的 1 条数据、设置和所有版本都会被删除，Family里的所有人都将失去它。此操作无法撤销。")).toBeVisible();
    // Its name in either language will do.
    await dialog.getByRole("textbox", { name: "输入“动态”以确认" }).fill("Feed");
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(family.getByText("动态已删除。")).toBeFocused();
    await family.getByRole("button", { name: "恢复Family的Ledger" }).click();
    await page.getByRole("dialog", { name: "恢复Family的Ledger？" }).getByRole("button", { name: "恢复", exact: true }).click();
    await expect(family.getByText("Ledger已恢复。")).toBeFocused();
    expect(api.appChanges).toEqual([
      `DELETE /api/spaces/${FAMILY_SPACE}/apps/m-feed/data {"confirm":"Feed"}`,
      `PUT /api/spaces/${FAMILY_SPACE}/apps/m-ledger {"memberAccess":"none"}`,
    ]);
  });

  test.describe("on a phone", () => {
    test.use(PHONE);

    test("moves an app in a dialog that fits the screen, with choices large enough to tap", async ({ page, api }) => {
      ownAFamily(api);
      api.setSession({ ...api.session, apps: [builtInApp("feed", PERSONAL_SPACE)] });
      await page.goto("/apps");
      const move = spaceCard(page, "Personal").getByRole("button", { name: "Move Feed", exact: true });
      expect((await move.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expectNothingPastTheEdge(page);

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
      expect(api.appChanges).toEqual([`POST /api/spaces/${PERSONAL_SPACE}/apps/m-feed/move {"toSpaceId":"${FAMILY_SPACE}","memberAccess":"edit"}`]);
    });

    test("the removed apps and the dialogs that bring one back or delete it for good fit the screen, in both languages", async ({ page, api }) => {
      for (const locale of ["en", "zh"] as const) {
        familyWithRemovedApps(api, locale);
        // A long name, made in the chat, which must wrap rather than push past the edge.
        api.groups[FAMILY_SPACE]!.apps.push({
          id: "m-long",
          hasCode: true,
          removedAt: "2026-11-02T08:00:00.000Z",
          rowCount: 2048,
          memberAccess: "none",
          members: {},
          assistant: true,
          name: { en: "Spending of the whole family, by month and by person", zh: "全家每月按人记录的开支明细与预算对照表" },
          icon: "wallet",
          color: "teal",
        });
        await page.goto("/apps");
        const family = spaceCard(page, "Family");
        const rows = family.getByRole("list", { name: locale === "zh" ? "已移除的应用" : "Removed apps" }).getByRole("listitem");
        await expect(rows).toHaveCount(3);
        await expectNothingPastTheEdge(page);
        for (const button of await rows.getByRole("button").all()) expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);

        for (const opens of [locale === "zh" ? /^恢复.*开支/ : /^Bring back Spending/, locale === "zh" ? /^永久删除.*开支/ : /^Delete permanently: Spending/]) {
          await family.getByRole("button", { name: opens }).tap();
          const dialog = page.getByRole("dialog");
          await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
          const box = await dialog.boundingBox();
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
          await dialog.getByRole("button", { name: locale === "zh" ? "取消" : "Cancel" }).tap();
          await expect(dialog).toBeHidden();
        }
      }
      expect(api.appChanges).toEqual([]);
    });

    test("fits the screen, with every control large enough to tap", async ({ page, api }) => {
      api.setSession({ ...emptySession(), apps: [builtInApp("checklist", PERSONAL_SPACE), builtInApp("feed", PERSONAL_SPACE)] });
      await page.goto("/apps");
      const personal = spaceCard(page, "Personal");
      await expect(personal.getByRole("switch", { name: "Show Checklist" })).toBeVisible();
      await expectNothingPastTheEdge(page);
      for (const name of ["Pin Checklist", "Settings of Checklist", "Remove Checklist"]) {
        const box = await personal.getByRole("button", { name }).boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

test.describe("the settings dialog", () => {
  test("changes a setting in English and then in Chinese, sending only what changed", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [builtInApp("checklist", PERSONAL_SPACE)] });
    await page.goto(`/apps/${PERSONAL_SPACE}/m-checklist`);
    // The app's whole page, in its sandbox.
    const app = sandbox(page, "m-checklist");
    await expect(app.getByRole("heading", { name: "Checklist" })).toBeVisible();
    await expect(app.locator("body")).toHaveAttribute("data-view", "page");

    await page.getByRole("banner").getByRole("button", { name: "Settings of Checklist" }).click();
    let dialog = page.getByRole("dialog", { name: "Checklist settings" });
    await dialog.getByRole("switch", { name: "Hide ticked items" }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    // The app's page, which reads its settings itself, is told to read them again.
    await expect(app.locator("body")).toHaveAttribute("data-changes", "1");

    // In Chinese the page is drawn again, in Chinese.
    await page.getByRole("button", { name: /Switch language/ }).click();
    await expect(app.getByRole("heading", { name: "清单" })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "清单的设置" }).click();
    dialog = page.getByRole("dialog", { name: "清单设置" });
    await expect(dialog.getByRole("group", { name: "对这个空间" })).toBeVisible();
    // The form starts from what was saved.
    await expect(dialog.getByRole("switch", { name: "隐藏已勾选的事项" })).toBeChecked();
    const sections = dialog.getByRole("group", { name: "分组" });
    await sections.getByRole("textbox", { name: "分组的新条目" }).fill("花园");
    await sections.getByRole("button", { name: "添加" }).click();
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();

    expect(api.appChanges).toEqual([
      `PATCH /api/spaces/${PERSONAL_SPACE}/apps/m-checklist/settings {"user":{"hideDone":true}}`,
      `PATCH /api/spaces/${PERSONAL_SPACE}/apps/m-checklist/settings {"space":{"sections":["花园"]}}`,
    ]);
  });

  test("shows the space's settings to a viewer without letting them change them", async ({ page, api }) => {
    api.setSession({ ...emptySession(), apps: [builtInApp("checklist", PERSONAL_SPACE, { access: "view" })] });
    await page.goto("/");
    await page.getByRole("button", { name: "Settings of Checklist" }).click();
    const dialog = page.getByRole("dialog", { name: "Checklist settings" });
    await expect(dialog.getByText("You may only view this app, so you cannot change these.")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "New entry in Sections" })).toHaveCount(0);
    await expect(dialog.getByRole("switch", { name: "Hide ticked items" })).toBeEnabled();
  });

  test("an app that was taken away disappears: a not_found from its settings loads the session again", async ({ page, api }) => {
    const session = sessionWithBuiltInApps();
    api.setSession(session);
    await page.goto("/");
    const grid = page.getByTestId("widget-grid");
    const checklist = grid.getByRole("region", { name: "Checklist in Family", exact: true });
    await expect(checklist).toBeVisible();
    expect(api.sessionRequests).toBe(1);

    // An owner removes the checklist from the family space while this page is open.
    api.setSession({ ...session, apps: session.apps.filter((app) => app.id !== "m-checklist") });
    await checklist.getByRole("button", { name: "Settings of Checklist in Family" }).click();

    // Its card goes, the dialog with it; the other app stays.
    await expect(checklist).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(grid.getByRole("region", { name: "Feed", exact: true })).toBeVisible();
    expect(api.sessionRequests).toBe(2);
    // The app's page is gone with it.
    await page.goto(`/apps/${FAMILY_SPACE}/m-checklist`);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  });

  test.describe("on a phone", () => {
    test.use(PHONE);

    test("fits the screen and saves", async ({ page, api }) => {
      api.setSession({ ...emptySession(), apps: [builtInApp("feed", PERSONAL_SPACE)] });
      await page.goto("/");
      await page.getByRole("button", { name: "Settings of Feed" }).tap();
      const dialog = page.getByRole("dialog", { name: "Feed settings" });
      await dialog.getByRole("button", { name: "Sport" }).tap();
      const box = await dialog.boundingBox();
      expect(box?.width).toBeLessThanOrEqual(390);
      await dialog.getByRole("button", { name: "Save" }).tap();
      await expect(dialog).toBeHidden();
      expect(api.appChanges).toEqual([`PATCH /api/spaces/${PERSONAL_SPACE}/apps/m-feed/settings {"user":{"topics":["sport"]}}`]);
      // The app's card, which reads its settings itself, is told to read them again.
      await expect(sandbox(page, "m-feed").locator("body")).toHaveAttribute("data-changes", "1");
    });
  });
});
