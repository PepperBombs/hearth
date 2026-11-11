/**
 * Groups in Settings, against the stand-in server (e2e/fixtures.ts):
 * creating a group, adding and inviting people, an owner's controls for a
 * member, taking an invitation back, and the table of who can use each app,
 * on a desktop and on a phone, in English and in Chinese. The same is done
 * between two people on the real server in e2e/real-server.spec.ts.
 */
import type { Page } from "@playwright/test";
import { FAMILY_SPACE, KIM, LIN, PHONE, emptySession, expect, expectNothingPastTheEdge, ownAFamily, sampleApp, test } from "./fixtures.ts";

const card = (page: Page, name: string) => page.getByRole("main").getByRole("region", { name });

test.describe("groups in Settings", () => {
  test("the server's owner creates a group, adds someone, invites someone and gives the group an app", async ({ page, api }) => {
    api.people = [LIN];
    api.setSession({ ...emptySession(), canCreateGroups: true, canInvitePeople: true });
    await page.goto("/settings");

    await card(page, "Groups").getByRole("button", { name: "Create a group" }).click();
    const create = page.getByRole("dialog", { name: "Create a group" });
    await create.getByLabel("Name").fill("Family");
    await create.getByRole("button", { name: "Create" }).click();
    await expect(create).toBeHidden();
    const family = card(page, "Family");
    await expect(family.getByText("You are an owner")).toBeVisible();
    // The new group is a space of its own everywhere, the sidebar included.
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("region", { name: "Family" })).toBeVisible();

    await family.getByRole("button", { name: "Add a person" }).click();
    let add = page.getByRole("dialog", { name: "Add a person to Family" });
    await add.getByLabel("Email address").fill("lin@example.com");
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(family.getByText("lin@example.com was added to the group.")).toBeVisible();
    await expect(family.getByRole("listitem").filter({ hasText: "Lin Example" })).toContainText("lin@example.com");

    await family.getByRole("button", { name: "Add a person" }).click();
    add = page.getByRole("dialog", { name: "Add a person to Family" });
    await add.getByLabel("Email address").fill("pat@example.com");
    await add.getByRole("group", { name: "Role" }).getByRole("button", { name: "Owner" }).click();
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(family.getByText("pat@example.com is invited, and joins the group when they first open Hearth.")).toBeVisible();
    await expect(family.getByRole("listitem").filter({ hasText: "pat@example.com" })).toContainText("InvitedOwner");

    // No apps yet; the card leads to the Apps page, where one added "everyone can view" then shows in the table.
    await expect(family.getByText("No apps in this group yet. Add one on the Apps page.")).toBeVisible();
    await family.getByRole("link", { name: "the Apps page" }).click();
    await card(page, "Family").getByRole("button", { name: "Add an app" }).click();
    const addApp = page.getByRole("dialog", { name: "Add an app to Family" });
    await addApp.getByRole("radio", { name: "Everyone can view" }).check();
    await addApp.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addApp).toBeHidden();
    await page.getByRole("link", { name: "Settings" }).click();
    const table = card(page, "Family").getByRole("table", { name: "Who can use each app" });
    await expect(table.getByRole("combobox", { name: "Everyone's access to Checklist" })).toHaveValue("view");
    await table.getByRole("combobox", { name: "Lin Example's access to Checklist" }).selectOption({ label: "Can edit" });
    const spaceId = api.session.spaces.find((space) => space.name === "Family")?.id;
    await expect.poll(() => api.groupChanges.at(-1)).toBe(`PUT /api/spaces/${spaceId}/apps/checklist/access {"members":{"${LIN.id}":"edit"}}`);
    expect(api.groupChanges.slice(0, 3)).toEqual([
      'POST /api/spaces {"name":"Family"}',
      `POST /api/spaces/${spaceId}/members {"email":"lin@example.com","role":"member","canAddApps":false}`,
      `POST /api/spaces/${spaceId}/members {"email":"pat@example.com","role":"owner"}`,
    ]);
  });

  test("an owner manages a member, takes an invitation back, and decides who can use an app", async ({ page, api }) => {
    ownAFamily(api);
    await page.goto("/settings");
    const family = card(page, "Family");

    const table = family.getByRole("table", { name: "Who can use each app" });
    await expect(table.getByRole("columnheader")).toHaveText(["App", "Everyone", "Lin Example", "Kim Example"]);
    await expect(table.getByRole("combobox", { name: "Lin Example's access to Checklist" })).toHaveValue("everyone");
    await expect(table.getByRole("combobox", { name: "Kim Example's access to Checklist" })).toHaveValue("edit");
    await table.getByRole("combobox", { name: "Everyone's access to Checklist" }).selectOption({ label: "No access" });
    await expect(table.getByRole("combobox", { name: "Lin Example's access to Checklist" }).getByRole("option", { name: "As everyone: no access" })).toBeAttached();

    await family.getByRole("button", { name: "Manage Lin Example" }).click();
    const manage = page.getByRole("dialog", { name: "Lin Example in Family" });
    await manage.getByRole("switch", { name: "Can add apps" }).click();
    await expect(manage.getByRole("switch", { name: "Can add apps" })).toHaveAttribute("aria-checked", "true");
    await manage.getByRole("button", { name: "Close" }).click();
    await expect(family.getByRole("listitem").filter({ hasText: "Lin Example" })).toContainText("Can add apps");

    await family.getByRole("button", { name: "Take back the invitation for pat@example.com" }).click();
    await expect(family.getByText("pat@example.com")).toHaveCount(0);

    await family.getByRole("button", { name: "Manage Kim Example" }).click();
    await page.getByRole("dialog", { name: "Kim Example in Family" }).getByRole("button", { name: "Remove from the group" }).click();
    await page.getByRole("dialog", { name: "Remove Kim Example from Family?" }).getByRole("button", { name: "Remove" }).click();
    await expect(family.getByRole("listitem").filter({ hasText: "Kim Example" })).toHaveCount(0);
    await expect(table.getByRole("columnheader")).toHaveText(["App", "Everyone", "Lin Example"]);

    expect(api.groupChanges).toEqual([
      `PUT /api/spaces/${FAMILY_SPACE}/apps/checklist/access {"memberAccess":"none"}`,
      `PATCH /api/spaces/${FAMILY_SPACE}/members/${LIN.id} {"canAddApps":true}`,
      `DELETE /api/spaces/${FAMILY_SPACE}/invitations {"email":"pat@example.com"}`,
      `DELETE /api/spaces/${FAMILY_SPACE}/members/${KIM.id} null`,
    ]);
  });

  test("selecting text in a dialog and letting go outside it keeps the dialog and what was typed", async ({ page, api }) => {
    ownAFamily(api);
    await page.goto("/settings");
    await card(page, "Family").getByRole("button", { name: "Add a person" }).click();
    const add = page.getByRole("dialog", { name: "Add a person to Family" });
    const email = add.getByLabel("Email address");
    await email.fill("noa@example.com");
    // The dialog opens with a slight zoom; measure it once that is over.
    await add.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    const field = (await email.boundingBox())!;
    const box = (await add.boundingBox())!;

    // Pressed in the field, dragged to its start and past the dialog's edge, let go over the backdrop.
    await page.mouse.move(field.x + field.width - 4, field.y + field.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 40, field.y + field.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(add).toBeVisible();
    await expect(email).toHaveValue("noa@example.com");

    // A click on the backdrop still closes it.
    await page.mouse.click(box.x - 40, box.y + 10);
    await expect(add).toBeHidden();
    expect(api.groupChanges).toEqual([]);
  });

  test("a member sees who is in the group and leaves it", async ({ page, api }) => {
    const session = emptySession();
    api.setSession({
      ...session,
      spaces: [
        ...session.spaces,
        {
          id: FAMILY_SPACE,
          kind: "group",
          name: "Family",
          role: "member",
          canAddApps: false,
          members: [
            { id: LIN.id, name: LIN.name, role: "owner" },
            { id: session.user.id, name: session.user.name, role: "member" },
          ],
        },
      ],
      apps: [sampleApp("checklist", FAMILY_SPACE, { access: "view" })],
    });
    api.groups[FAMILY_SPACE] = { apps: [], members: [], invitations: [] };
    await page.goto("/settings");
    const family = card(page, "Family");
    await expect(family.getByRole("listitem")).toHaveText(["LLin ExampleOwner", "SSam Example (you)"]);
    await expect(family.getByRole("table")).toHaveCount(0);

    await family.getByRole("button", { name: "Leave the group" }).click();
    await page.getByRole("dialog", { name: "Leave Family?" }).getByRole("button", { name: "Leave" }).click();
    await expect(family).toHaveCount(0);
    await expect(card(page, "Groups").getByText("You are not in a group yet.", { exact: false })).toBeVisible();
    // Its apps went with it.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("heading", { name: "No widgets yet" })).toBeVisible();
  });

  test.describe("on a phone, in Chinese", () => {
    test.use(PHONE);

    test("fits the screen: the table scrolls inside the card, and every control is large enough to tap", async ({ page, api }) => {
      ownAFamily(api, { locale: "zh" });
      api.groups[FAMILY_SPACE]!.members.push({ id: "user-4", name: "Noa Example", email: "noa@example.com", role: "member", canAddApps: false });
      api.setSession({
        ...api.session,
        spaces: api.session.spaces.map((space) =>
          space.id === FAMILY_SPACE ? { ...space, members: [...space.members, { id: "user-4", name: "Noa Example", role: "member" }] } : space,
        ),
      });
      await page.goto("/settings");
      const family = card(page, "Family");
      const table = family.getByRole("table", { name: "每个应用谁可以使用" });
      await expect(table.getByRole("combobox", { name: "Lin Example对清单的权限" })).toBeVisible();
      // The table scrolls inside its own scroller, which fits; nothing else reaches past the edge.
      await expectNothingPastTheEdge(page);
      const scroller = family.getByTestId("access-scroller");
      expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      const familyBox = await family.boundingBox();
      expect((familyBox?.x ?? 0) + (familyBox?.width ?? 0)).toBeLessThanOrEqual(390);

      for (const control of [
        family.getByRole("button", { name: "管理Lin Example" }),
        family.getByRole("button", { name: "撤回对 pat@example.com 的邀请" }),
        family.getByRole("button", { name: "添加成员" }),
        family.getByRole("button", { name: "退出群组" }),
        table.getByRole("combobox", { name: "所有人对清单的权限" }),
      ]) {
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }

      await family.getByRole("button", { name: "添加成员" }).tap();
      const add = page.getByRole("dialog", { name: "向Family添加成员" });
      expect((await add.boundingBox())?.width).toBeLessThanOrEqual(390);
      await add.getByLabel("电子邮件地址").fill("kim@example.com");
      await add.getByRole("button", { name: "添加", exact: true }).tap();
      await expect(add.getByText("这个人已经在群组里，或已经收到邀请。")).toBeVisible();
    });
  });
});
