/**
 * A model's reply drawn from Markdown, and what it may not do on the page:
 * no HTML of its own, nothing loaded from anywhere, and links only to
 * http(s) and mailto addresses, each opening in a new tab.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreferencesProvider } from "../session/preferences";
import { Markdown, safeHref } from "./markdown";

function draw(text: string): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <PreferencesProvider>
        <Markdown text={text} />
      </PreferencesProvider>
    </QueryClientProvider>,
  );
  return container;
}

describe("a reply in Markdown", () => {
  it("draws paragraphs, lists, bold, italics, code, quotes and tables", () => {
    const shown = draw(
      [
        "First **bold** and *italic* and `code`.",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "```",
        "const a = 1;",
        "```",
        "",
        "| Item | Price |",
        "| --- | --- |",
        "| Milk | 1.20 |",
        "",
        "~~gone~~",
      ].join("\n"),
    );
    expect(shown.querySelector("strong")?.textContent).toBe("bold");
    expect(shown.querySelector("em")?.textContent).toBe("italic");
    expect(shown.querySelector("p > code")?.textContent).toBe("code");
    expect(within(shown).getAllByRole("list")).toHaveLength(2);
    expect(shown.querySelector("ol")?.textContent).toContain("second");
    expect(shown.querySelector("blockquote")?.textContent?.trim()).toBe("quoted");
    expect(shown.querySelector("pre > code")?.textContent).toBe("const a = 1;\n");
    expect(within(shown).getByRole("table")).toBeTruthy();
    expect(within(shown).getByRole("cell", { name: "Milk" })).toBeTruthy();
    expect(shown.querySelector("del")?.textContent).toBe("gone");
  });

  it("puts its headings under the page's own: never a second h1", () => {
    const shown = draw("# Big\n\n## Smaller\n\ntext");
    expect(within(shown).queryByRole("heading", { level: 1 })).toBeNull();
    expect(within(shown).queryByRole("heading", { level: 2 })).toBeNull();
    expect(within(shown).getByRole("heading", { level: 3, name: "Big" })).toBeTruthy();
    expect(within(shown).getByRole("heading", { level: 4, name: "Smaller" })).toBeTruthy();
  });

  it("draws HTML in a reply as the text it is, never as elements", () => {
    const html = [
      '<script>window.ran = true</script>',
      '<img src="https://example.com/x.png" onerror="window.ran = true">',
      '<iframe src="https://example.com"></iframe>',
      '<a href="https://example.com">raw link</a>',
      '<b onclick="window.ran = true">bold?</b>',
    ].join("\n\n");
    const shown = draw(html);
    for (const tag of ["script", "img", "iframe", "a", "b", "style"]) expect(shown.querySelector(tag), tag).toBeNull();
    expect(shown.querySelector("[onerror], [onclick]")).toBeNull();
    // What was written is all still there to read, as text.
    expect(shown.textContent).toContain("<script>window.ran = true</script>");
    expect(shown.textContent).toContain('<a href="https://example.com">raw link</a>');
    expect((window as { ran?: boolean }).ran).toBeUndefined();
  });

  it("loads no image: it is a link to the picture, named by its alt text", () => {
    const shown = draw("Look: ![a cat on a mat](https://example.com/cat.png \"Cat\")");
    expect(shown.querySelector("img, picture, source, [src], [srcset]")).toBeNull();
    const link = within(shown).getByRole("link", { name: "a cat on a mat" });
    expect(link.getAttribute("href")).toBe("https://example.com/cat.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("names an image with no alt text by its address, and makes no link of one that is not http(s)", () => {
    expect(within(draw("![](https://example.com/a.png)")).getByRole("link", { name: "https://example.com/a.png" })).toBeTruthy();
    const shown = draw("![tracker](data:image/png;base64,AAAA) and ![relative](/api/session)");
    expect(shown.querySelector("img, [src]")).toBeNull();
    expect(within(shown).queryByRole("link")).toBeNull();
    expect(shown.textContent).toContain("tracker");
    expect(shown.textContent).toContain("relative");
  });

  it("opens an http(s) or mailto link in a new tab, with no way back to this page", () => {
    const shown = draw("[Docs](https://example.com/docs), [plain](http://example.com) and [mail](mailto:someone@example.com), and www.example.com");
    for (const [name, href] of [
      ["Docs", "https://example.com/docs"],
      ["plain", "http://example.com"],
      ["mail", "mailto:someone@example.com"],
      ["www.example.com", "http://www.example.com"],
    ] as const) {
      const link = within(shown).getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("makes no link of a javascript:, data: or other address, and keeps its text", () => {
    const shown = draw(
      [
        "[one](javascript:alert(1))",
        "[two](JaVaScRiPt:alert(1))",
        "[three]( javascript:alert(1))",
        "[four](data:text/html,<script>alert(1)</script>)",
        "[five](vbscript:msgbox)",
        "[six](/api/session)",
        "[seven](#somewhere)",
        "<javascript:alert(1)>",
      ].join("\n\n"),
    );
    expect(within(shown).queryByRole("link")).toBeNull();
    expect(shown.querySelector("a, [href]")).toBeNull();
    for (const text of ["one", "two", "three", "four", "five", "six", "seven"]) expect(screen.getByText(text)).toBeTruthy();
  });
});

describe("a reply the parser cannot draw", () => {
  // Overflowing the stack, and React drawing it again before the boundary takes it, is slow under a loaded machine.
  const SLOW = 30_000;

  // Nested this deep, the parser runs out of stack: a short reply a model can be led to write.
  it.each([
    ["quotes", `${">".repeat(3000)} hi`],
    ["lists", `${"- ".repeat(1500)}x`],
  ])("nested %s show as plain text, and the rest of the page stays", (_what, deep) => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <PreferencesProvider>
          <nav>Conversations</nav>
          <Markdown text={deep} />
        </PreferencesProvider>
      </QueryClientProvider>,
    );
    expect(within(container).getByText("Conversations")).toBeTruthy();
    expect(container.textContent).toContain(deep);
    expect(container.querySelector("blockquote, ul")).toBeNull();
  }, SLOW);

  it("is drawn from Markdown again once its text is one the parser can draw", () => {
    const deep = `${">".repeat(3000)} hi`;
    const client = new QueryClient();
    const view = (text: string) => (
      <QueryClientProvider client={client}>
        <PreferencesProvider>
          <Markdown text={text} />
        </PreferencesProvider>
      </QueryClientProvider>
    );
    const { container, rerender } = render(view(deep));
    expect(container.querySelector("strong")).toBeNull();
    rerender(view("Now **bold**"));
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  }, SLOW);
});

describe("safeHref", () => {
  it("keeps absolute http, https and mailto addresses alone", () => {
    expect(safeHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeHref("HTTP://example.com")).toBe("HTTP://example.com");
    expect(safeHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("refuses every other address, and what is no address", () => {
    for (const url of ["javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.com", "/relative", "#hash", "example.com", "", null, undefined]) {
      expect(safeHref(url), String(url)).toBeUndefined();
    }
  });
});
