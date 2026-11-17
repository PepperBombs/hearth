/**
 * `<MadeAppFrame>`: the page of an app made in Hearth, in its sandbox
 * (docs/platform.md, "The sandbox"), and the other end of its bridge.
 *
 * The iframe has `sandbox="allow-scripts allow-forms"`, so the page has an origin of its
 * own and can reach nothing of Hearth's. Its `window.hearth` asks this
 * component by message; this component answers with the person's sign-in,
 * always for the app and space it drew the iframe for, whatever the message
 * says, and only to messages from that iframe.
 */
import type { AppSummary } from "@hearth/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { pickLocalized } from "../i18n";
import { usePreferences } from "../session/preferences";
import { addRow, listRows, removeRow, updateRow, type ListOptions } from "./api";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One call of the bridge, for this app in this space alone. */
async function answer(app: AppSummary, op: unknown, args: unknown): Promise<unknown> {
  if (!isRecord(args) || typeof args.collection !== "string") throw new Error("Every call names a collection.");
  const { collection } = args;
  switch (op) {
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

export function MadeAppFrame({ app, maxHeight = 560 }: { app: AppSummary; maxHeight?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { locale, resolvedTheme } = usePreferences();
  const [height, setHeight] = useState(200);
  const src =
    `/api/spaces/${encodeURIComponent(app.spaceId)}/apps/${encodeURIComponent(app.id)}/frame` +
    `?theme=${resolvedTheme}&locale=${locale}`;

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
            if (message.op !== "list") notifyMadeAppChanged(app.id, own);
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

  return (
    <iframe
      ref={frame}
      title={pickLocalized(app.name, locale)}
      src={src}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className="block w-full rounded-ctl border-0 bg-surface"
      style={{ height }}
      data-made-app={app.id}
    />
  );
}
