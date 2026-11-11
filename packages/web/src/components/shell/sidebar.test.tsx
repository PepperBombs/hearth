/**
 * The desktop sidebar: the pages it leads to, the Apps page among them,
 * and what it says under a space that has nothing to open.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { AppSummary, Session } from "@hearth/shared";
import { PreferencesProvider } from "../../session/preferences";
import { SessionContext } from "../../session/session";
import { Shell } from "./shell";

function app(id: string, spaceId: string, extra: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    spaceId,
    name: { en: id[0]!.toUpperCase() + id.slice(1), zh: id },
    description: { en: "A sample app", zh: "示例应用" },
    icon: "box",
    color: "green",
    widgetSize: "small",
    access: "edit",
    enabled: true,
    pinned: false,
    hasPage: true,
    ...extra,
  };
}

const me = { id: "u1", name: "Sam Example", role: "owner" as const };
const session: Session = {
  user: { id: "u1", email: "sam@example.com", name: "Sam Example", locale: "en", theme: "light" },
  spaces: [
    { id: "p", kind: "personal", name: "", role: "owner", canAddApps: true, members: [me] },
    { id: "f", kind: "group", name: "Family", role: "owner", canAddApps: true, members: [me] },
    { id: "b", kind: "group", name: "Book club", role: "owner", canAddApps: true, members: [me] },
    { id: "w", kind: "group", name: "Work", role: "owner", canAddApps: true, members: [me] },
  ],
  apps: [
    // The personal space has a widget and nothing to open.
    app("feed", "p", { hasPage: false }),
    app("grocery", "f"),
    // The book club's one app is switched off: for this person it has none.
    app("notes", "b", { enabled: false }),
  ],
  canCreateGroups: false,
  canInvitePeople: false,
  version: "dev",
};

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderShell(value: Session = session) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreferencesProvider>
        <SessionContext value={value}>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<Shell />}>
                <Route path="*" element={<Where />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </SessionContext>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
}

const sidebar = () => screen.getByRole("navigation", { name: "Main" });
const current = (link: HTMLElement) => link.getAttribute("aria-current") === "page";

describe("the sidebar", () => {
  it("leads to the Apps page, where apps are added, and marks it while it is open", () => {
    renderShell();
    const apps = within(sidebar()).getByRole("link", { name: "Apps" });
    expect(apps.getAttribute("href")).toBe("/apps");
    expect(current(apps)).toBe(false);

    fireEvent.click(apps);
    expect(screen.getByTestId("where").textContent).toBe("/apps");
    expect(current(within(sidebar()).getByRole("link", { name: "Apps" }))).toBe(true);

    // An app's own page is marked by the app's own link, not by "Apps".
    fireEvent.click(within(sidebar()).getByRole("link", { name: "Grocery" }));
    expect(screen.getByTestId("where").textContent).toBe("/apps/f/grocery");
    expect(current(within(sidebar()).getByRole("link", { name: "Grocery" }))).toBe(true);
    expect(current(within(sidebar()).getByRole("link", { name: "Apps" }))).toBe(false);
  });

  it("says a space has no apps only when it has none switched on, and says so of widgets that have no page", () => {
    renderShell();
    const section = (name: string) => within(sidebar()).getByRole("region", { name });

    expect(within(section("Personal")).queryByText("No apps yet")).toBeNull();
    expect(within(section("Personal")).getByText("Widgets only, on the dashboard")).toBeTruthy();
    expect(within(section("Personal")).queryByRole("link")).toBeNull();

    expect(within(section("Family")).getByRole("link", { name: "Grocery" })).toBeTruthy();
    expect(within(section("Family")).queryByText("No apps yet")).toBeNull();

    // Switched off is hidden for this person, as everywhere but the Apps page.
    expect(within(section("Book club")).getByText("No apps yet")).toBeTruthy();
    expect(within(section("Work")).getByText("No apps yet")).toBeTruthy();
  });

  it("speaks Chinese", () => {
    window.localStorage.setItem("hearth.locale", "zh");
    renderShell({ ...session, user: { ...session.user, locale: "zh" } });
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: "应用" }).getAttribute("href")).toBe("/apps");
    expect(within(within(nav).getByRole("region", { name: "个人" })).getByText("仅小组件，显示在仪表盘上")).toBeTruthy();
  });
});
