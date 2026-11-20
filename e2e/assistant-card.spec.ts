/**
 * The Assistant card in Settings, against the stand-in server
 * (e2e/fixtures.ts), on a phone: what each person's own model may do in
 * each of their spaces, with a group its owner switched on, so that the
 * card draws the group's level and its apps. What the card does when it is
 * pressed is tried in packages/web/src/assistant/assistant-card.test.tsx,
 * and what the levels allow in packages/server/src/assistant/switches.test.ts.
 */
import { FAMILY_SPACE, PHONE, expect, expectNothingPastTheEdge, ownAFamily, test } from "./fixtures.ts";

test.describe("the Assistant card on a phone", () => {
  test.use(PHONE);

  test("fits the screen with a group's apps and a long name on it, in both languages", async ({ page, api }) => {
    // One word as long as a group's name may be.
    const groupName = "TheExampleFamilyOfTheNorthernHillsAndValleysWhoWalkTogetherEveryWeekendOfTheYear".slice(0, 80);
    expect(groupName).toHaveLength(80);
    const texts = [
      { locale: "en", title: "Assistant", chat: "the chat", edit: "Read and change", checklist: "Checklist" },
      { locale: "zh", title: "AI 助手", chat: "对话", edit: "读写", checklist: "清单" },
    ] as const;

    for (const { locale, title, chat, edit, checklist } of texts) {
      ownAFamily(api, { locale });
      api.setSession({
        ...api.session,
        spaces: api.session.spaces.map((space) => (space.id === FAMILY_SPACE ? { ...space, name: groupName, assistant: "edit" } : space)),
      });
      await page.goto("/settings");
      const card = page.getByRole("main").getByRole("region", { name: title, exact: true });
      await card.scrollIntoViewIfNeeded();
      await expect(card.getByRole("link", { name: chat })).toHaveAttribute("href", "/chat");
      const row = card.getByTestId(`assistant-space-${FAMILY_SPACE}`);
      await expect(row.getByText(groupName, { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: edit })).toHaveAttribute("aria-pressed", "true");
      await expect(row.getByRole("checkbox", { name: checklist })).toBeChecked();
      await expectNothingPastTheEdge(page);
    }
  });
});
