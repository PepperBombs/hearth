/**
 * Checks the colour tokens themselves: every text colour must reach a contrast
 * of 4.5:1 on every surface it is used on, in light and in dark, and every
 * icon colour 3:1.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read from disk: the test runner replaces imported CSS with an empty module.
const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles/tokens.css"), "utf8");

type Rgb = [number, number, number];

function parseBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No block for ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const values: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) values[match[1] ?? ""] = (match[2] ?? "").trim();
  return values;
}

const light = parseBlock(tokens, ":root");
const dark = { ...light, ...parseBlock(tokens, ':root[data-theme="dark"]') };

function hex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match?.[1]) throw new Error(`Not a hex colour: ${value}`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function resolve(theme: Record<string, string>, name: string): Rgb {
  const value = theme[name];
  if (!value) throw new Error(`No token ${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias?.[1] ? resolve(theme, alias[1]) : hex(value);
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [text token, background token] for every pairing the components use. */
const pairs: Array<[string, string]> = [
  ...["--hearth-text", "--hearth-text-2", "--hearth-text-3"].flatMap((text): Array<[string, string]> =>
    ["--hearth-bg", "--hearth-side", "--hearth-surface", "--hearth-surface-2"].map((background) => [text, background]),
  ),
  ["--hearth-accent-text", "--hearth-accent-soft"],
  ["--hearth-text", "--hearth-accent-soft"],
  ["--hearth-text-3", "--hearth-accent-soft"],
  ["--hearth-on-accent", "--hearth-accent"],
  ["--hearth-accent", "--hearth-surface"],
  ["--hearth-accent-text", "--hearth-surface"],
  ["--hearth-accent", "--hearth-side"],
  ["--hearth-warn-text", "--hearth-warn-bg"],
  ["--hearth-text-2", "--hearth-warn-bg"],
  ["--hearth-up", "--hearth-surface"],
  ["--hearth-down", "--hearth-surface"],
];

/**
 * App colours are used for icons only, never for text, and every icon sits next to a text label.
 * Graphics need 3:1 (WCAG 1.4.11), which the approved palette meets on every surface.
 */
const iconPairs: Array<[string, string]> = ["green", "purple", "teal", "amber", "pink", "orange", "blue"].flatMap(
  (color): Array<[string, string]> => [
    [`--hearth-app-${color}`, "--hearth-surface"],
    [`--hearth-app-${color}`, "--hearth-side"],
    [`--hearth-app-${color}`, "--hearth-accent-soft"],
  ],
);

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme", (_name, theme) => {
  it.each(pairs)("%s on %s is at least 4.5:1", (text, background) => {
    expect(contrast(resolve(theme, text), resolve(theme, background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(iconPairs)("icon colour %s on %s is at least 3:1", (icon, background) => {
    expect(contrast(resolve(theme, icon), resolve(theme, background))).toBeGreaterThanOrEqual(3);
  });
});
