/**
 * Renders the PNG app icons from the SVG sources in public/icons.
 * Run with `pnpm --filter @hearth/web icons` after changing an SVG, and commit the result.
 * Uses the Chromium that Playwright (a root dev dependency) already provides.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, "../public/icons");
const rounded = join(icons, "icon.svg");
// Full-bleed with the mark inside the safe zone, for launchers that cut their own shape.
// Only a source for the PNGs below, so it lives here and is not served.
const fullBleed = join(here, "icon-maskable.svg");

/** [source SVG, output PNG, size in pixels] */
const targets = [
  [rounded, "icon-192.png", 192],
  [rounded, "icon-512.png", 512],
  [fullBleed, "icon-maskable-512.png", 512],
  // iOS does not round transparent corners, so the home-screen icon is full-bleed too.
  [fullBleed, "apple-touch-icon.png", 180],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [source, output, size] of targets) {
    const svg = await readFile(source, "utf8");
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(join(icons, output), png);
    console.log(`${output} ${size}x${size}`);
  }
} finally {
  await browser.close();
}
