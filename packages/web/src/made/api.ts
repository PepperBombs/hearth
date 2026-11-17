/**
 * What the web app asks the server about apps made in Hearth and each
 * person's own model (docs/platform.md): the model's settings, the chat's
 * stream of events, and the rows a made app's page reads and writes through
 * the page around it (frame.tsx).
 */
import {
  chatEventSchema,
  modelSettingsSchema,
  type ChatEvent,
  type ChatRequest,
  type MadeRow,
  type ModelSettings,
  type ModelSettingsRequest,
} from "@hearth/shared";
import { ApiRequestError, request } from "../session/api";

const JSON_HEADERS = { "Content-Type": "application/json" };

export const MODEL_QUERY_KEY = ["model"] as const;

/** GET /api/me/model: what the person saved, without the key, or null. */
export async function fetchModelSettings(signal?: AbortSignal): Promise<ModelSettings | null> {
  const response = await request("/api/me/model", { signal });
  const body: unknown = await response.json().catch(() => undefined);
  if (body === null) return null;
  const parsed = modelSettingsSchema.safeParse(body);
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The model's settings did not match the expected shape.");
  return parsed.data;
}

export async function saveModelSettings(body: ModelSettingsRequest): Promise<ModelSettings> {
  const response = await request("/api/me/model", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
  const parsed = modelSettingsSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The model's settings did not match the expected shape.");
  return parsed.data;
}

export async function forgetModelSettings(): Promise<void> {
  await request("/api/me/model", { method: "DELETE" });
}

/**
 * POST /api/chat, read as it comes: `onEvent` gets each event but the
 * pings. Ends when the server ends the stream; throws when it cannot be
 * reached, or with an AbortError when stopped.
 */
export async function streamChat(body: ChatRequest, onEvent: (event: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await request("/api/chat", {
    method: "POST",
    headers: { ...JSON_HEADERS, Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (data === "") continue;
      const parsed = chatEventSchema.safeParse(JSON.parse(data));
      if (parsed.success && parsed.data.type !== "ping") onEvent(parsed.data);
    }
  }
}

/** Where a made app's rows of one collection are. */
const rowsPath = (spaceId: string, appId: string, collection: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}/apps/${encodeURIComponent(appId)}/rows/${encodeURIComponent(collection)}`;

export type ListOptions = { orderBy?: string; desc?: boolean; limit?: number };

export async function listRows(spaceId: string, appId: string, collection: string, options: ListOptions): Promise<MadeRow[]> {
  const query = new URLSearchParams();
  if (options.orderBy) query.set("orderBy", options.orderBy);
  if (options.desc) query.set("desc", "true");
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const response = await request(`${rowsPath(spaceId, appId, collection)}?${query.toString()}`);
  return ((await response.json()) as { rows: MadeRow[] }).rows;
}

export async function addRow(spaceId: string, appId: string, collection: string, data: Record<string, unknown>): Promise<MadeRow> {
  const response = await request(rowsPath(spaceId, appId, collection), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ data }) });
  return ((await response.json()) as { row: MadeRow }).row;
}

export async function updateRow(
  spaceId: string,
  appId: string,
  collection: string,
  rowId: string,
  data: Record<string, unknown>,
): Promise<MadeRow> {
  const response = await request(`${rowsPath(spaceId, appId, collection)}/${encodeURIComponent(rowId)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ data }),
  });
  return ((await response.json()) as { row: MadeRow }).row;
}

export async function removeRow(spaceId: string, appId: string, collection: string, rowId: string): Promise<void> {
  await request(`${rowsPath(spaceId, appId, collection)}/${encodeURIComponent(rowId)}`, { method: "DELETE" });
}
