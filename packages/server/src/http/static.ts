/**
 * Serves the built web app: its files, and index.html for every other path
 * so that client-side routes survive a reload.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Handler } from "hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

/** Vite puts every file whose name carries a content hash in this folder. */
const HASHED_PREFIX = "/assets/";

const CACHE_FOREVER = "public, max-age=31536000, immutable";
/** "Ask the server every time." A 304 answer keeps it cheap. */
const CACHE_REVALIDATE = "no-cache";
const CACHE_BRIEFLY = "public, max-age=3600";

/** Pictures and fonts outside the hashed folder, such as icons, change rarely. */
const BRIEFLY_CACHED = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff2",
  ".woff",
  ".ttf",
  ".otf",
]);

/**
 * Hashed files never change, so browsers may keep them for good. Everything
 * else that decides which version of the app runs (the page, the service
 * worker, the web manifest, any script or style sheet without a hash in its
 * name) is checked with the server every time.
 */
export function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith(HASHED_PREFIX)) return CACHE_FOREVER;
  return BRIEFLY_CACHED.has(extname(urlPath).toLowerCase()) ? CACHE_BRIEFLY : CACHE_REVALIDATE;
}

type FoundFile = { path: string; size: number; etag: string };

async function findFile(path: string): Promise<FoundFile | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return {
      path,
      size: info.size,
      etag: `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
    };
  } catch {
    return null;
  }
}

/**
 * Maps a URL path to a file inside root, or null if it must not be served:
 * anything that would leave root, and hidden files.
 */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment.startsWith("."))) return null;
  const path = resolve(root, ...segments);
  return path === root || path.startsWith(root + sep) ? path : null;
}

// Both languages at once: nothing is known about the reader when the app itself is missing.
const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hearth</title>
</head>
<body>
<h1>Hearth</h1>
<p>The server is running, but the web app has not been built, so there is nothing to show here yet.</p>
<p>Build it with <code>pnpm build</code>, or point <code>HEARTH_WEB_DIST</code> at the folder that holds the built web app. In development, open the address of the web dev server instead.</p>
<p lang="zh-Hans">服务器正在运行，但网页应用尚未构建，所以这里暂时没有内容。</p>
<p lang="zh-Hans">请运行 <code>pnpm build</code> 进行构建，或将 <code>HEARTH_WEB_DIST</code> 指向已构建网页应用所在的文件夹。开发时请改为打开网页开发服务器的地址。</p>
</body>
</html>
`;

/**
 * A handler for every GET outside /api. The folder is looked at on each
 * request, so building the web app later needs no restart.
 */
export function serveWebApp(webDist: string): Handler {
  const root = resolve(webDist);

  return async (c) => {
    const urlPath = new URL(c.req.url).pathname;

    let servedPath = urlPath;
    const candidate = urlPath === "/" ? null : resolveInside(root, urlPath);
    let file = candidate ? await findFile(candidate) : null;

    if (!file) {
      // A missing hashed file is a real 404. Answering with the page would
      // hand HTML to a browser expecting a script after a new deploy.
      if (urlPath.startsWith(HASHED_PREFIX)) {
        return c.text("Not found", 404, { "Cache-Control": "no-store" });
      }
      servedPath = "/index.html";
      file = await findFile(resolve(root, "index.html"));
    }

    if (!file) {
      // No folder, or a folder without index.html: say so instead of failing.
      c.header("Cache-Control", "no-store");
      return c.html(NOT_BUILT_PAGE, 503);
    }

    const headers: Record<string, string> = {
      "Content-Type": MIME_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": cacheControlFor(servedPath),
      ETag: file.etag,
    };

    if (c.req.header("if-none-match") === file.etag) {
      return new Response(null, { status: 304, headers });
    }
    headers["Content-Length"] = String(file.size);
    if (c.req.method === "HEAD") return new Response(null, { status: 200, headers });

    const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  };
}
