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

/**
 * A stopped app stays stopped for as long as this copy of Hearth is loaded,
 * which here is the whole test file: each test draws an app of its own.
 */
const ledger = (id: string): AppSummary => ({ ...LEDGER, id });

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
    const app = ledger("m-bbbbbbbbbb");
    const redraw = draw(app);
    load();
    act(() => preferences.setTheme("dark"));
    expect(frame()?.getAttribute("src")).toContain("theme=dark");
    load();
    act(() => preferences.setLocale("zh"));
    load();
    redraw({ ...app, version: 2 });
    load();
    expect(frame()).not.toBeNull();

    // A second load at the address of the moment is still caught, and said in the reader's language.
    load();
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("这个应用试图离开自己的页面，已被拦下。");
  });

  it("keeps a stopped app stopped in another theme, and gives its next version a frame again", () => {
    const app = ledger("m-cccccccccc");
    const redraw = draw(app);
    load();
    load();
    act(() => preferences.setTheme("dark"));
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(STOPPED);

    // A change in the chat makes a new version, which may well be the fix.
    redraw({ ...app, version: 2 });
    expect(frame()?.getAttribute("src")).toContain("v=2");
    expect(screen.queryByRole("alert")).toBeNull();
    load();
    expect(frame()).not.toBeNull();
  });

  it("keeps a stopped app stopped after the person leaves and comes back, and wherever else it is drawn", () => {
    const app = ledger("m-dddddddddd");
    draw(app);
    load();
    load();
    expect(screen.getByRole("alert").textContent).toBe(STOPPED);

    // Leaving the dashboard takes the card away; coming back draws it afresh, and the page is not served again.
    cleanup();
    draw(app);
    expect(frame()).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(STOPPED);

    // Its page, drawn in another place, is not served either; another app's is.
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PreferencesProvider>
          <MadeAppFrame app={app} view="page" />
          <MadeAppFrame app={ledger("m-eeeeeeeeee")} />
        </PreferencesProvider>
      </QueryClientProvider>,
    );
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector("iframe")?.getAttribute("data-made-app")).toBe("m-eeeeeeeeee");
    expect(screen.getByRole("alert").textContent).toBe(STOPPED);
  });

  it("takes every frame of a version off the screen when one of them leaves", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PreferencesProvider>
          <MadeAppFrame app={ledger("m-ffffffffff")} />
          <MadeAppFrame app={ledger("m-ffffffffff")} view="page" />
        </PreferencesProvider>
      </QueryClientProvider>,
    );
    const first = document.querySelector("iframe") as HTMLIFrameElement;
    fireEvent.load(first);
    fireEvent.load(first);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
});
