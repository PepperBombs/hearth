/**
 * The app center's page (docs/center.md), against the stand-in server
 * (e2e/fixtures.ts): reached from the Apps page, it lists the built-in apps
 * and what is published to the person's groups, on a computer and on a
 * phone, in both languages, unpublishes the person's own, and adds a copy
 * and opens the chat on it; and, on an app's page, the publish dialog and
 * the line of a copy. The whole loop against the real server is step 9's in
 * docs/center.md.
 */
import type { Page } from "@playwright/test";
import type { CenterListing, PublishReview } from "../packages/shared/src/index.ts";
import {
  FAMILY_SPACE,
  LIN,
  PERSONAL_SPACE,
  PHONE,
  builtInApp,
  expect,
  expectNothingPastTheEdge,
  ownAFamily,
  test,
  type FakeApi,
} from "./fixtures.ts";

function listing(id: string, extra: Partial<CenterListing> = {}): CenterListing {
  return {
    id,
    spaceId: FAMILY_SPACE,
    name: { en: "Ledger", zh: "Ledger" },
    description: { en: "What the family spends, by month and by person.", zh: "What the family spends, by month and by person." },
    icon: "wallet",
    color: "green",
    collections: [{ name: "expenses", fields: ["amount", "date", "category", "note", "paid_by"] }],
    publishedBy: { id: LIN.id, name: LIN.name },
    revision: 3,
    note: "Totals by person",
    updatedAt: "2026-11-03T10:00:00.000Z",
    mine: false,
    canUnpublish: true,
    ...extra,
  };
}

/** Sam owns the family; Lin published a ledger there, and Sam a reading list. */
function familyWithListings(api: FakeApi, locale: "en" | "zh" = "en"): void {
  ownAFamily(api, { locale });
  api.center = [
    listing("p-ledger0001"),
    listing("p-reading001", {
      name: { en: "Reading list", zh: "Reading list" },
      description: { en: "Books to read next.", zh: "Books to read next." },
      collections: [],
      publishedBy: { id: "user-1", name: "Sam Example" },
      revision: 1,
      note: "",
      mine: true,
    }),
  ];
}

/** What the publish dialog reads for Sam's ledger: published to Family once, with long instructions and a page line that holds an address. */
const REVIEW: PublishReview = {
  app: {
    name: { en: "Ledger", zh: "账本" },
    description: { en: "What the family spends, by month and by person.", zh: "家里每月、每人的花销。" },
    icon: "wallet",
    color: "green",
    collections: [{ name: "expenses", fields: ["amount", "date", "category", "note", "paid_by"] }],
    settings: { currency: { type: "text", label: { en: "Currency", zh: "货币" }, scope: "space", default: "EUR" } },
    instructions:
      "Keep one entry per expense, with its amount in the space's currency and the person who paid. A_very_long_word_without_any_place_to_break_it_that_must_still_wrap_inside_the_dialog.",
    pageBytes: 23_456,
  },
  groups: [{ id: FAMILY_SPACE, name: "Family" }],
  listings: [{ id: "p-ledger0001", spaceId: FAMILY_SPACE, revision: 2, note: "Totals", updatedAt: "2026-11-03T10:00:00.000Z", canUnpublish: true }],
  problems: [],
};

/** Sam owns the family and has a ledger of his own, and a copy of Lin's ledger, in his personal space. */
function ledgerAndCopy(api: FakeApi, locale: "en" | "zh"): void {
  ownAFamily(api, { locale });
  const ledger = { name: REVIEW.app.name, description: REVIEW.app.description, template: undefined, settings: undefined };
  api.setSession({
    ...api.session,
    apps: [
      ...api.session.apps,
      builtInApp("checklist", PERSONAL_SPACE, { id: "m-ledger0001", ...ledger }),
      builtInApp("checklist", PERSONAL_SPACE, { id: "m-copy00001", ...ledger, source: { listingId: "p-other00001", by: LIN.name } }),
    ],
  });
  api.publishReview = REVIEW;
}

const region = (page: Page, name: string) => page.getByRole("main").getByRole("region", { name });

test.describe("the app center", () => {
  test("is reached from the Apps page and lists what the server gives", async ({ page, api }) => {
    familyWithListings(api);
    await page.goto("/apps");
    await page.getByRole("main").getByRole("heading", { level: 2, name: "Family" }).waitFor();
    await page.getByRole("banner").getByRole("link", { name: "App center" }).click();
    await expect(page).toHaveURL(/\/center$/);
    await expect(page.getByRole("heading", { level: 1, name: "App center" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "App center" })).toHaveAttribute("aria-current", "page");

    await expect(region(page, "From Hearth").getByText("Checklist", { exact: true })).toBeVisible();
    const family = region(page, "In Family");
    await expect(family.getByRole("heading", { level: 3 })).toHaveText(["Ledger", "Reading list"]);
    await expect(family.getByText("By Lin Example, Nov 3")).toBeVisible();
    await expect(family.getByText("Revision 3: Totals by person")).toBeVisible();
    await expect(family.getByText("expenses: amount, date, category, note, paid_by")).toBeVisible();
    await expect(family.getByText("It reads and changes only its own entries, and reaches no website.")).toHaveCount(2);

    const mine = region(page, "Mine");
    await mine.getByRole("button", { name: "Unpublish Reading list from Family" }).click();
    const dialog = page.getByRole("dialog", { name: "Unpublish “Reading list” from Family?" });
    await dialog.getByRole("button", { name: "Unpublish", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "“Reading list” is no longer published." })).toBeFocused();
    await expect(mine).toBeHidden();
    await expect(family.getByRole("heading", { level: 3 })).toHaveText(["Ledger"]);
    expect(api.centerChanges).toEqual(["/api/center/p-reading001"]);
  });

  test.describe("on a phone", () => {
    test.use(PHONE);

    test("adds a copy to the personal space and opens the chat on it", async ({ page, api }) => {
      familyWithListings(api);
      await page.goto("/center");
      await region(page, "In Family").getByRole("button", { name: "Add a copy of Ledger" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a copy of “Ledger”" });
      await expect(dialog.getByRole("radio", { name: /Personal/ })).toBeChecked();
      await expectNothingPastTheEdge(page);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await expect(dialog.getByText("A copy of “Ledger” is in your personal space now.")).toBeFocused();
      expect(api.appChanges).toEqual([`POST /api/spaces/${PERSONAL_SPACE}/center/p-ledger0001 {}`]);

      await dialog.getByRole("link", { name: "Change it in the chat" }).click();
      await expect(page).toHaveURL(new RegExp(`/chat\\?space=${PERSONAL_SPACE}$`));
      await expect(page.getByRole("textbox", { name: "Message your model" })).toHaveValue("Change “Ledger”: ");

      // Back in the center, the personal space now says it holds a copy, with Open.
      await page.goto("/center");
      await region(page, "In Family").getByRole("button", { name: "Add a copy of Ledger" }).click();
      await expect(dialog.getByRole("radio", { name: /Personal/ })).toBeDisabled();
      await expect(dialog.getByRole("link", { name: "Open the copy in your personal space" })).toHaveAttribute("href", `/apps/${PERSONAL_SPACE}/m-copy-1`);
    });

    test("publishes again from an app's page, and a copy's page says whose app it was, in both languages", async ({ page, api }) => {
      for (const locale of ["en", "zh"] as const) {
        const zh = locale === "zh";
        ledgerAndCopy(api, locale);
        await page.goto(`/apps/${PERSONAL_SPACE}/m-ledger0001`);
        await page.getByRole("button", { name: zh ? "发布账本…" : "Publish Ledger…" }).click();
        const dialog = page.getByRole("dialog", { name: zh ? "发布「账本」" : "Publish “Ledger”" });
        await expect(dialog.getByRole("region", { name: zh ? "将要分享的内容" : "What will be shared" }).getByText(/A_very_long_word/)).toBeVisible();
        await expectNothingPastTheEdge(page);
        await dialog.getByRole("button", { name: zh ? "重新发布到Family" : "Publish again to Family" }).click();
        await dialog.getByRole("textbox", { name: zh ? "修改了什么（可选）" : "What changed (optional)" }).fill("By person");
        await dialog.getByText(zh ? "我已检查过，这里面没有隐私内容" : "I have checked that this holds nothing private").click();
        await dialog.getByRole("button", { name: zh ? "重新发布" : "Publish again", exact: true }).click();
        await expect(dialog.getByText(zh ? "已发布到Family，第 3 版。" : "Published to Family, revision 3.")).toBeFocused();
        expect(api.publishes.at(-1)).toBe(`POST /api/spaces/${PERSONAL_SPACE}/apps/m-ledger0001/publish {"to":"${FAMILY_SPACE}","note":"By person"}`);

        await page.goto(`/apps/${PERSONAL_SPACE}/m-copy00001`);
        await expect(page.getByText(zh ? "这是 Lin Example 分享的应用的副本" : "A copy of an app Lin Example shared")).toBeVisible();
        await expect(page.getByRole("link", { name: zh ? "在对话里修改" : "Change it in the chat" })).toHaveAttribute(
          "href",
          `/chat?space=${PERSONAL_SPACE}&app=m-copy00001`,
        );
        await expectNothingPastTheEdge(page);
      }
    });

    test("fits the screen in both languages, with Apps lit in the tab bar", async ({ page, api }) => {
      for (const locale of ["en", "zh"] as const) {
        familyWithListings(api, locale);
        await page.goto("/center");
        const zh = locale === "zh";
        await expect(page.getByRole("heading", { level: 1, name: zh ? "应用中心" : "App center" })).toBeVisible();
        const family = region(page, zh ? "Family里分享的" : "In Family");
        await expect(family.getByText(zh ? "第 3 版：Totals by person" : "Revision 3: Totals by person")).toBeVisible();
        await expect(region(page, zh ? "我发布的" : "Mine")).toBeVisible();
        await expect(region(page, zh ? "Hearth 自带" : "From Hearth").getByRole("listitem")).toHaveCount(2);
        const tabs = page.getByRole("navigation", { name: zh ? "标签栏" : "Tabs" });
        await expect(tabs.getByRole("link", { name: zh ? "应用" : "Apps" })).toHaveAttribute("aria-current", "page");
        await expectNothingPastTheEdge(page);
        const unpublish = family.getByRole("button", { name: zh ? "从Family取消发布Ledger" : "Unpublish Ledger from Family" });
        expect((await unpublish.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
});
