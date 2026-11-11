import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { Session } from "@hearth/shared";
import { PreferencesProvider } from "../../session/preferences";
import { SessionContext } from "../../session/session";
import { Shell } from "../shell/shell";

const session: Session = {
  user: { id: "u1", email: "sam@example.com", name: "Sam Example", locale: "en", theme: "light" },
  spaces: [
    { id: "p", kind: "personal", name: "", role: "owner", canAddApps: true, members: [{ id: "u1", name: "Sam Example", role: "owner" }] },
    { id: "f", kind: "group", name: "Family", role: "owner", canAddApps: true, members: [{ id: "u1", name: "Sam Example", role: "owner" }] },
  ],
  apps: [
    {
      id: "grocery",
      spaceId: "f",
      name: { en: "Grocery", zh: "购物清单" },
      description: { en: "Shared shopping list", zh: "全家共用的购物清单" },
      icon: "shopping-bag",
      color: "green",
      widgetSize: "tall",
      access: "edit",
      enabled: true,
      pinned: false,
      hasPage: true,
    },
  ],
  canCreateGroups: false,
  canInvitePeople: false,
  version: "dev",
};

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderShell() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreferencesProvider>
        <SessionContext value={session}>
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

const where = () => screen.getByTestId("where").textContent;
const pressShortcut = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(window, { key: "k", ...init }));
const options = () => screen.queryAllByRole("option").map((option) => option.textContent);

describe("quick switcher", () => {
  it("opens and closes with Ctrl+K and with Cmd+K", () => {
    renderShell();
    expect(screen.queryByRole("combobox")).toBeNull();
    pressShortcut({ ctrlKey: true });
    expect(screen.getByRole("combobox")).toBeTruthy();
    pressShortcut({ ctrlKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    pressShortcut({ metaKey: true });
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("ignores a plain K and other combinations", () => {
    renderShell();
    pressShortcut({});
    pressShortcut({ ctrlKey: true, shiftKey: true });
    pressShortcut({ ctrlKey: true, altKey: true });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("lists pages, apps and actions, and finds them in either language", () => {
    renderShell();
    pressShortcut({ ctrlKey: true });
    expect(options().join("|")).toContain("Dashboard");
    expect(options().join("|")).toContain("Grocery");
    expect(options().join("|")).toContain("Switch to dark mode");

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "购物" } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("Grocery");

    fireEvent.change(input, { target: { value: "设置" } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("Settings");

    fireEvent.change(input, { target: { value: "语言" } });
    expect(options()[0]).toContain("中文");

    fireEvent.change(input, { target: { value: "qqqq" } });
    expect(options()).toHaveLength(0);
    expect(screen.getByText("Nothing matches. Try another word.")).toBeTruthy();
  });

  it("does not act on Enter while an input method is composing", () => {
    renderShell();
    pressShortcut({ ctrlKey: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "设置" } });

    // Enter that confirms a candidate in the input method: nothing may open.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(where()).toBe("/");
    expect(screen.getByRole("combobox")).toBeTruthy();
    // Some browsers report the composing key press only through keyCode 229.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(where()).toBe("/");

    // A real Enter afterwards opens the result and closes the switcher.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(where()).toBe("/settings");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("opens an app and runs actions", () => {
    renderShell();
    pressShortcut({ ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gro" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(where()).toBe("/apps/f/grocery");

    pressShortcut({ ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dark" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    pressShortcut({ ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "chinese" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(document.documentElement.lang).toBe("zh-Hans");
    expect(screen.getByRole("link", { name: "仪表盘" })).toBeTruthy();
  });
});
