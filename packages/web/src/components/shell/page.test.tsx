/**
 * A screen's frame inside the shell: the top bar, with the title, the
 * screen's own buttons and the browser tab's name, and the content area,
 * which scrolls as a whole unless the screen fills it and scrolls its own
 * parts (the chat).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreferencesProvider } from "../../session/preferences";
import { Page, type PageProps } from "./page";
import { SwitcherContext } from "./switcher-state";

function draw(props: Omit<PageProps, "children">) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreferencesProvider>
        <SwitcherContext value={{ open: false, setOpen: () => {} }}>
          <Page {...props}>
            <p>Content</p>
          </Page>
        </SwitcherContext>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
  return { bar: screen.getByRole("banner"), content: screen.getByRole("main") };
}

const classes = (element: HTMLElement) => element.className.split(/\s+/);

describe("Page", () => {
  it("names the screen in the top bar and the browser tab, with its own buttons there", () => {
    const { bar } = draw({ title: "Plan the week", actions: <button type="button">New</button> });
    expect(within(bar).getByRole("heading", { level: 1, name: "Plan the week" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "New" })).toBeTruthy();
    expect(document.title).toBe("Plan the week · Hearth");
  });

  it("can show another heading in the top bar, keeping the title as the browser tab's name", () => {
    const { bar } = draw({ title: "Plan the week", heading: "Chat" });
    expect(within(bar).getByRole("heading", { level: 1 }).textContent).toBe("Chat");
    expect(document.title).toBe("Plan the week · Hearth");
  });

  it("scrolls its content as a whole, with the page's padding, by default", () => {
    const { content } = draw({ title: "Apps" });
    expect(within(content).getByText("Content")).toBeTruthy();
    expect(content.hasAttribute("data-fill")).toBe(false);
    expect(classes(content)).toEqual(expect.arrayContaining(["overflow-auto", "p-6"]));
  });

  it("with fill, gives its content the whole room as a column that does not scroll as a whole, without padding", () => {
    const { content } = draw({ title: "Chat", fill: true });
    expect(within(content).getByText("Content")).toBeTruthy();
    expect(content.hasAttribute("data-fill")).toBe(true);
    expect(classes(content)).toEqual(expect.arrayContaining(["flex", "flex-col", "overflow-hidden", "min-h-0", "flex-1"]));
    expect(classes(content)).not.toContain("overflow-auto");
    expect(classes(content).filter((name) => /^(max-md:)?p[xytrbl]?-/.test(name))).toEqual([]);
  });
});
