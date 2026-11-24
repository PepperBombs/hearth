/**
 * `<MadeAppFrame>`: the page of an app made in Hearth, in its sandbox
 * (docs/platform.md, "The sandbox"), and the other end of its bridge.
 *
 * The iframe has `sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"`, so the page has an origin of its
 * own and can reach nothing of Hearth's. Its `window.hearth` asks this
 * component by message; this component answers with the person's sign-in,
 * always for the app and space it drew the iframe for, whatever the message
 * says, and only to messages from that iframe.
 *
 * It also guards the frame (docs/center.md, "Privacy and safety"): a page
 * may load once for each address this component gives the iframe. A second
 * `load` for the same address means the page navigated its frame somewhere
 * else, so the frame is taken off the screen and a line says why.
 */
import type { AppSummary } from "@hearth/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { pickLocalized } from "../i18n";
import { usePreferences } from "../session/preferences";
import { addRow, fetchForApp, listRows, readSettings, removeRow, replaceRows, saveSettings, updateRow, type ListOptions } from "./api";

type Listener = (source: Window | null) => void;
const listeners = new Map<string, Set<Listener>>();

/**
 * Tells every page of this app on screen that its data changed, so that it
 * reads it again: after the chat changed it, or another page of it did.
 * `source`, the page that changed it, is not told.
 */
export function notifyMadeAppChanged(appId: string, source: Window | null = null): void {
  for (const listener of listeners.get(appId) ?? []) listener(source);
}

/** The calls that change the app's data or settings, after which its other pages read again. */
const WRITES: ReadonlySet<string> = new Set(["add", "update", "remove", "replace", "saveSettings"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One call of the bridge, for this app in this space alone. */
async function answer(app: AppSummary, op: unknown, args: unknown): Promise<unknown> {
  if (!isRecord(args)) throw new Error("A call takes an object.");
  // Calls about the app as a whole.
  switch (op) {
    case "settings":
      return readSettings(app.spaceId, app.id);
    case "saveSettings":
      if (!isRecord(args.patch)) throw new Error("saveSettings takes { space?, user? }.");
      return saveSettings(app.spaceId, app.id, args.patch);
    case "fetch": {
      if (typeof args.url !== "string") throw new Error("fetch takes an address.");
      const headers = isRecord(args.headers) ? Object.fromEntries(Object.entries(args.headers).map(([k, v]) => [k, String(v)])) : {};
      return fetchForApp(app.spaceId, app.id, args.url, headers);
    }
  }
  if (typeof args.collection !== "string") throw new Error("Every call about rows names a collection.");
  const { collection } = args;
  switch (op) {
    case "replace": {
      if (!Array.isArray(args.rows) || !args.rows.every(isRecord)) throw new Error("replace takes a list of rows.");
      // What it replaces is named, every time: nothing missing or unreadable may stand for "every row",
      // and a field left undefined, which JSON would drop on the way, must not either.
      const { where } = args;
      if (!isRecord(where)) throw new Error("replace takes where: the fields and values of the rows it replaces ({} for every row).");
      const unset = Object.keys(where).find((field) => where[field] === undefined);
      if (unset !== undefined) throw new Error(`where.${unset} is undefined: leave the field out, or give its value.`);
      return replaceRows(app.spaceId, app.id, collection, where, args.rows);
    }
    case "list": {
      const options = isRecord(args.options) ? args.options : {};
      const list: ListOptions = {
        ...(typeof options.orderBy === "string" ? { orderBy: options.orderBy } : {}),
        ...(options.desc === true ? { desc: true } : {}),
        ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      };
      return listRows(app.spaceId, app.id, collection, list);
    }
    case "add":
      if (!isRecord(args.data)) throw new Error("add takes an object of fields.");
      return addRow(app.spaceId, app.id, collection, args.data);
    case "update":
      if (typeof args.id !== "string" || !isRecord(args.data)) throw new Error("update takes a row's id and an object of fields.");
      return updateRow(app.spaceId, app.id, collection, args.id, args.data);
    case "remove":
      if (typeof args.id !== "string") throw new Error("remove takes a row's id.");
      await removeRow(app.spaceId, app.id, collection, args.id);
      return null;
    default:
      throw new Error(`There is no call "${String(op)}".`);
  }
}

/**
 * `view`: in the app's card, where its page shows what fits a card, or on
 * the app's own page, where it shows everything (`hearth.view`).
 */
export function MadeAppFrame({ app, view = "card", maxHeight = 560 }: { app: AppSummary; view?: "card" | "page"; maxHeight?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { locale, resolvedTheme, t } = usePreferences();
  const [height, setHeight] = useState(200);
  const src =
    `/api/spaces/${encodeURIComponent(app.spaceId)}/apps/${encodeURIComponent(app.id)}/frame` +
    // The version, so that a change to the app draws its new page.
    `?theme=${resolvedTheme}&locale=${locale}&view=${view}&v=${app.version ?? 1}`;

  // The frame guard. `loads` counts the iframe's loads since `src` last changed: the page Hearth served
  // loads once, and a second load for the same address is the page, or a link in it the person clicked,
  // navigating the frame away. What it put in the new address may already have left; what it reads of
  // the app's data from now on does not, since the frame is gone. A stopped app stays stopped, in other
  // themes, languages and views too, until its next version (a change in the chat) or a reload of Hearth.
  const loads = useRef(0);
  useLayoutEffect(() => {
    loads.current = 0;
  }, [src]);
  const version = `${app.spaceId}/${app.id}@${app.version ?? 1}`;
  const [stopped, setStopped] = useState<string | null>(null);
  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) setStopped(version);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const message: unknown = event.data;
      if (!isRecord(message)) return;
      if (message.type === "hearth:size" && typeof message.height === "number") {
        setHeight(Math.min(Math.max(Math.ceil(message.height), 80), maxHeight));
      } else if (message.type === "hearth:call" && typeof message.id === "number") {
        const reply = (body: { ok: true; result: unknown } | { ok: false; error: string }) =>
          own.postMessage({ type: "hearth:reply", id: message.id, ...body }, "*");
        answer(app, message.op, message.args).then(
          (result) => {
            reply({ ok: true, result });
            // Only a write changes what the app's other pages show: telling them after a read too would
            // have two pages of one app on screen wake each other for ever.
            if (WRITES.has(String(message.op))) notifyMadeAppChanged(app.id, own);
          },
          (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app, maxHeight]);

  const onChanged = useCallback<Listener>((source) => {
    const own = frame.current?.contentWindow;
    if (own && own !== source) own.postMessage({ type: "hearth:changed" }, "*");
  }, []);
  useEffect(() => {
    let set = listeners.get(app.id);
    if (!set) listeners.set(app.id, (set = new Set()));
    set.add(onChanged);
    return () => {
      set.delete(onChanged);
    };
  }, [app.id, onChanged]);

  if (stopped === version) {
    return (
      <p role="alert" className="rounded-ctl bg-surface px-3 py-4 text-sm text-down" data-made-app-stopped={app.id}>
        {t("made.leftPage")}
      </p>
    );
  }

  return (
    <iframe
      // One frame per app: another app's page gets a frame of its own, so that the page shown before,
      // and its messages still on their way, are gone with their frame and never answered as the next app.
      key={`${app.spaceId}/${app.id}`}
      ref={frame}
      title={pickLocalized(app.name, locale)}
      src={src}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="block w-full rounded-ctl border-0 bg-surface"
      style={{ height }}
      onLoad={onLoad}
      data-made-app={app.id}
    />
  );
}
