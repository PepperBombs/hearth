/**
 * The calls the shell makes for a mini-app: one of its queries or mutations,
 * its settings, adding it to a space or removing it, and the person's own
 * switch and pin. A mini-app's own code never builds an address; it names a
 * route, and `<AppScope>` (./scope.tsx) knows the space and the app.
 *
 * Shapes are in @hearth/shared; answers are checked against them.
 */
import {
  appCallResponseSchema,
  appSettingsSchema,
  type AddAppRequest,
  type AppPrefsPatch,
  type AppSettings,
  type AppSettingsPatch,
} from "@hearth/shared";
import { ApiRequestError, request } from "../session/api";

/** One app in one space: what every call is about. */
export type Install = { spaceId: string; appId: string };

function address(install: Install, rest = ""): string {
  const base = `/api/spaces/${encodeURIComponent(install.spaceId)}/apps/${encodeURIComponent(install.appId)}`;
  return rest === "" ? base : `${base}/${rest}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export type AppCall = Install & {
  kind: "query" | "mutation";
  /** The route's name in the app's `server.ts`. */
  name: string;
  /** What the route takes; undefined for a route that takes nothing. */
  input: unknown;
  signal?: AbortSignal;
};

/**
 * POST .../q/:name or .../m/:name. Resolves with what the route answered,
 * which is undefined for a mutation that returns nothing.
 */
export async function callAppRoute(call: AppCall): Promise<unknown> {
  const segment = call.kind === "query" ? "q" : "m";
  const response = await request(address(call, `${segment}/${encodeURIComponent(call.name)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // An undefined input is left out by JSON.stringify, which is what the server expects for "none".
    body: JSON.stringify({ input: call.input }),
    signal: call.signal,
  });
  const parsed = appCallResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new ApiRequestError("invalid_response", response.status, "The app's answer did not match the expected shape.");
  }
  return parsed.data.output;
}

/** GET .../settings: the values the space shares and the person's own, defaults filled in. */
export async function fetchAppSettings(install: Install, signal?: AbortSignal): Promise<AppSettings> {
  const response = await request(address(install, "settings"), { signal });
  const parsed = appSettingsSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new ApiRequestError("invalid_response", response.status, "The app's settings did not match the expected shape.");
  }
  return parsed.data;
}

/**
 * PATCH .../settings: saves the values named, all of them or none, and
 * resolves with every setting as the server now holds it.
 */
export async function saveAppSettings(install: Install, patch: AppSettingsPatch): Promise<AppSettings> {
  const response = await request(address(install, "settings"), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  const parsed = appSettingsSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    throw new ApiRequestError("invalid_response", response.status, "The app's settings did not match the expected shape.");
  }
  return parsed.data;
}

/** PUT /api/spaces/:spaceId/apps/:appId: adds an app to a space, or brings a removed one back. No body comes back. */
export async function addAppToSpace(install: Install, body: AddAppRequest): Promise<void> {
  await request(address(install), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** DELETE /api/spaces/:spaceId/apps/:appId: removes an app from a space. Its data is kept. */
export async function removeAppFromSpace(install: Install): Promise<void> {
  await request(address(install), { method: "DELETE" });
}

/** PATCH .../me: the person's own switch and pin for the app. No body comes back. */
export async function patchAppPrefs(install: Install, patch: AppPrefsPatch): Promise<void> {
  await request(address(install, "me"), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) });
}
