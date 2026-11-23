/**
 * The page of an app made in Hearth, as the sandbox serves it
 * (docs/platform.md, "The sandbox"): the app's own HTML, with the theme's
 * colours and the bridge put in front of it.
 *
 * The page runs in an iframe with `sandbox="allow-scripts allow-forms"` and the same
 * sandbox in its own Content-Security-Policy, so it has an origin of its
 * own: it cannot read Hearth's pages, cookies or storage, and the policy
 * lets it load and send nothing. All it can do with data is ask the page
 * around it through `window.hearth`, for the rows of its own app in its own
 * space, which that page fetches with the person's sign-in.
 */
import type { Locale } from "@hearth/shared";
import type { MadeManifest } from "./manifest";

/**
 * Everything the app's page may load comes inside the page itself; it may
 * connect to nothing, send no form anywhere, and be framed only by Hearth.
 * The sandbox gives it an opaque origin even when opened by itself, outside
 * the iframe. `allow-forms` only lets a form's submit event fire, which a
 * page handles itself: `form-action 'none'` still stops any submission.
 * Without it browsers drop the event, and every form of a page is dead.
 * `allow-popups` with `allow-popups-to-escape-sandbox` lets a link open a
 * site in a new tab, as itself (GitHub Trending opens repositories); a page
 * can send nothing more that way than by navigating its own frame. Dialogs
 * (alert, confirm, prompt) stay blocked.
 */
export const SANDBOX_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox",
].join("; ");

export const THEMES = ["light", "dark"] as const;
export type FrameTheme = (typeof THEMES)[number];

/** Where the page is drawn: in its card on the dashboard, or on a page of its own (`hearth.view`). */
export type FrameView = "card" | "page";

/**
 * Who is looking, and the space the app is in with its members' names
 * (`hearth.user`, `hearth.space`), as the apps of earlier releases had
 * them: a page says who wrote a row from its `createdBy`. The people of the
 * space see each other's names in Hearth already.
 */
export type FramePeople = {
  user: { id: string; name: string };
  space: { kind: "personal" | "group"; name: string; members: { id: string; name: string }[] };
};

/** The colours of Hearth's look ("A · Clean"), as packages/web/src/styles/tokens.css has them. */
const COLOURS: Record<FrameTheme, Record<string, string>> = {
  light: {
    bg: "#f1f4f9",
    surface: "#ffffff",
    "surface-2": "#eef1f6",
    line: "#dde2ea",
    text: "#141a24",
    "text-2": "#434c5b",
    "text-3": "#5b6575",
    accent: "#0b60d8",
    "accent-soft": "#dbe8fd",
    "accent-text": "#0a4fb3",
  },
  dark: {
    bg: "#10141b",
    surface: "#1a2029",
    "surface-2": "#242c38",
    line: "#2e3745",
    text: "#e6eaf0",
    "text-2": "#b4bdca",
    "text-3": "#98a2b1",
    accent: "#5b9cf5",
    "accent-soft": "#1b2d4d",
    "accent-text": "#a9cbfb",
  },
};

function themeStyle(theme: FrameTheme): string {
  const variables = Object.entries(COLOURS[theme])
    .map(([name, value]) => `--hearth-${name}:${value}`)
    .join(";");
  return (
    `:root{${variables};color-scheme:${theme}}` +
    "html,body{margin:0;background:var(--hearth-surface);color:var(--hearth-text);" +
    "font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}"
  );
}

/**
 * `window.hearth`, the app's one way to its data. Every call is a message to
 * the page around it, which answers with the result or an error. That page
 * knows which app this is from where it put the iframe, not from anything
 * the app says, so an app can reach its own rows alone.
 */
const BRIDGE = `(() => {
  const info = JSON.parse(document.currentScript.dataset.info);
  const waiting = new Map();
  const listeners = [];
  let next = 0;
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "hearth:reply") {
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      if (message.ok) call.resolve(message.result);
      else call.reject(new Error(String(message.error)));
    } else if (message.type === "hearth:changed") {
      if (listeners.length === 0) location.reload();
      for (const listener of listeners) {
        try { listener(); } catch (error) { console.error(error); }
      }
    }
  });
  const call = (op, args) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      parent.postMessage({ type: "hearth:call", id, op, args }, "*");
    });
  window.hearth = Object.freeze({
    app: info.app,
    locale: info.locale,
    theme: info.theme,
    access: info.access,
    view: info.view,
    user: info.user,
    space: info.space,
    list: (collection, options) => call("list", { collection, options: options || {} }),
    add: (collection, data) => call("add", { collection, data }),
    update: (collection, id, data) => call("update", { collection, id, data }),
    remove: (collection, id) => call("remove", { collection, id }),
    replace: (collection, where, rows) => call("replace", { collection, where, rows }),
    settings: () => call("settings", {}),
    saveSettings: (patch) => call("saveSettings", { patch }),
    fetch: (url, options) => call("fetch", { url, headers: (options && options.headers) || {} }),
    onChange: (listener) => { listeners.push(listener); },
  });
  // The height of what the page holds: the body's, with its margins. The
  // document's own is never less than the iframe's, so it could not shrink.
  // A page sized to its frame (height: 100vh, with padding) grows with it:
  // when the frame grew and the page still overflows it by as much as
  // before, that is the echo of the last report, which is left unsent, or
  // the frame would grow for ever.
  let sent = -1;
  let frame = -1;
  const report = () => {
    const body = document.body;
    if (!body) return;
    const style = getComputedStyle(body);
    const height = Math.ceil(body.scrollHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom));
    const inner = innerHeight;
    const echo = sent >= 0 && inner !== frame && height > inner && height - inner === sent - frame;
    frame = inner;
    if (echo) return;
    sent = height;
    parent.postMessage({ type: "hearth:size", height }, "*");
  };
  const watch = () => {
    report();
    new ResizeObserver(report).observe(document.body);
  };
  if (document.body) watch();
  else addEventListener("DOMContentLoaded", watch);
  addEventListener("load", report);
})();`;

/** JSON that can sit inside an HTML attribute without ending it. */
const attributeJson = (value: unknown) =>
  JSON.stringify(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function frameDocument(
  app: { manifest: MadeManifest; html: string },
  options: { theme: FrameTheme; locale: Locale; access: "view" | "edit"; view: FrameView; people?: FramePeople },
): string {
  const info = {
    access: options.access,
    view: options.view,
    user: options.people?.user ?? null,
    space: options.people?.space ?? { kind: "personal", name: "", members: [] },
    app: {
      name: app.manifest.name,
      collections: Object.fromEntries(
        Object.entries(app.manifest.collections).map(([name, collection]) => [name, collection.fields]),
      ),
    },
    locale: options.locale,
    theme: options.theme,
  };
  const prelude =
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${themeStyle(options.theme)}</style>` +
    `<script data-info="${attributeJson(info)}">${BRIDGE}</script>`;
  const { html } = app;
  // Before anything of the app's own, so that `window.hearth` is there when its scripts run.
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + prelude + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${prelude}</head>${html.slice(at)}`;
  }
  return `<!doctype html><html lang="${options.locale === "zh" ? "zh-CN" : "en"}"><head>${prelude}</head><body>${html}</body></html>`;
}
