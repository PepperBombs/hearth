/**
 * The frame guard (docs/center.md, "Privacy and safety"): an app's page
 * loads once for each address `MadeAppFrame` gives its iframe, and a second
 * load for the same address, the page navigating its frame away, takes the
 * frame off the screen with a line that says why.
 */
import type { AppSummary } from "@hearth/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreferencesProvider, usePreferences } from "../session/preferences";
import { MadeAppFrame } from "./frame";

const LEDGER: AppSummary = {
  id: "m-aaaaaaaaaa",
  spaceId: "space-personal",
  name: { en: "Ledger", zh: "账本" },
  description: { en: "Daily spending.", zh: "每天的花销。" },
  icon: "list-checks",
  color: "teal",
  widgetSize: "wide",
  access: "edit",
  enabled: true,
  pinned: false,
  hasPage: true,
  made: true,
  version: 1,
};

/** Lets the test change the theme and the language, as the person does in the shell. */
let preferences: ReturnType<typeof usePreferences>;
function Preferences() {
  preferences = usePreferences();
  return null;
}

function draw(app: AppSummary) {
  const tree = (current: AppSummary) => (
    <QueryClientProvider client={new QueryClient()}>
      <PreferencesProvider>
        <Preferences />
        <MadeAppFrame app={current} />
      </PreferencesProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(app));
  return (next: AppSummary) => rerender(tree(next));
}

const frame = () => document.querySelector("iframe");
/** The iframe's `load`, as the browser fires it when a document finishes loading in it. */
const load = () => fireEvent.load(frame() as HTMLIFrameElement);
const STOPPED = "This app tried to leave its page and was stopped.";

afterEach(cleanup);

describe("the frame guard", () => {
  it("keeps a page that loads once, and takes it away when it loads a second time at the same address", () => {
    draw(LEDGER);
    load();
    expect(frame()).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // The page navigated its frame away (or reloaded itself): the frame goes, and the card says why.
    load();
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(STOPPED);
  });

  it("counts again from a new address: another theme, language or version is a load of its own", () => {
    const redraw = draw(LEDGER);
    load();
    act(() => preferences.setTheme("dark"));
    expect(frame()?.getAttribute("src")).toContain("theme=dark");
    load();
    act(() => preferences.setLocale("zh"));
    load();
    redraw({ ...LEDGER, version: 2 });
    load();
    expect(frame()).not.toBeNull();

    // A second load at the address of the moment is still caught, and said in the reader's language.
    load();
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("这个应用试图离开自己的页面，已被拦下。");
  });

  it("keeps a stopped app stopped in another theme, and gives its next version a frame again", () => {
    const redraw = draw(LEDGER);
    load();
    load();
    act(() => preferences.setTheme("dark"));
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(STOPPED);

    // A change in the chat makes a new version, which may well be the fix.
    redraw({ ...LEDGER, version: 2 });
    expect(frame()?.getAttribute("src")).toContain("v=2");
    expect(screen.queryByRole("alert")).toBeNull();
    load();
    expect(frame()).not.toBeNull();
  });
});
