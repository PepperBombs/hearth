/**
 * The apps shipped with Hearth (docs/platform.md, "Built-in apps"): each a
 * folder of `packages/server/catalog`, holding the `manifest.json` and the
 * `page.html` of an app made in Hearth. Anyone who may add apps to a space
 * adds one from the Apps page, as a made app of its own, which can then be
 * changed to fit; every install of the build's app of the same name moves to
 * it when the server starts (legacy.ts).
 *
 * The server only reads them: they are written by hand, packaged with the
 * release, and checked at start-up like any made app, so that a broken one
 * stops the server before it serves anything.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMadeManifest, madeHtmlSchema, madeManifestSchema, type MadeManifest } from "./manifest";

export type Template = { id: string; manifest: MadeManifest; html: string };

/** A built-in app's ID, which is also its folder's name. */
const TEMPLATE_ID = /^[a-z][a-z0-9-]{1,30}$/;

/** packages/server/catalog, whether the server runs from src or from dist. */
export function catalogDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return join(dir, "catalog");
    const parent = dirname(dir);
    if (parent === dir) return join(process.cwd(), "catalog");
    dir = parent;
  }
}

/** Reads and checks every built-in app. Throws, naming the app and why, when one is not valid. */
export function loadCatalog(dir: string = catalogDir()): Template[] {
  if (!existsSync(dir)) return [];
  const templates: Template[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const where = `Built-in app "${id}" (${join(dir, id)})`;
    if (!TEMPLATE_ID.test(id)) throw new Error(`${where}: a folder is named after the app's ID, in lower-case letters, digits and hyphens.`);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, id, "manifest.json"), "utf8"));
    } catch (error) {
      throw new Error(`${where}: manifest.json cannot be read as JSON (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
    }
    const manifest = madeManifestSchema.safeParse(json);
    if (!manifest.success) throw new Error(`${where}: manifest.json is not valid: ${manifest.error.message}`);
    const problem = checkMadeManifest(manifest.data);
    if (problem !== null) throw new Error(`${where}: manifest.json is not valid: ${problem}`);
    const html = madeHtmlSchema.safeParse(readFileSync(join(dir, id, "page.html"), "utf8"));
    if (!html.success) throw new Error(`${where}: page.html is not valid: ${html.error.message}`);
    templates.push({ id, manifest: manifest.data, html: html.data });
  }
  return templates;
}
