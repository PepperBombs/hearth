/**
 * The calls the shell makes about an app in a space, rather than inside it:
 * its settings, removing it, bringing it back, deleting it for good or
 * moving it to another space, and the person's own switch and pin. Adding a built-in app is in ../made/api.ts, and what
 * an app made in Hearth reads and writes goes through its page's bridge
 * (../made/frame.tsx).
 *
 * Shapes are in @hearth/shared; answers are checked against them.
 */
import {
  appSettingsSchema,
  type AddAppRequest,
  type AppPrefsPatch,
  type AppSettings,
  type AppSettingsPatch,
  type MoveAppRequest,
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

/** DELETE /api/spaces/:spaceId/apps/:appId: removes an app from a space. Its data is kept. */
export async function removeAppFromSpace(install: Install): Promise<void> {
  await request(address(install), { method: "DELETE" });
}

/** PUT /api/spaces/:spaceId/apps/:appId: brings a removed app back to its space, with its data. Owners only. */
export async function bringBackApp(install: Install, body: AddAppRequest): Promise<void> {
  await request(address(install), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/**
 * DELETE .../data: deletes an app from its space for good, in use or
 * removed, with its rows, settings and versions. Owners only; `confirm` is
 * the app's name as the person typed it (its ID for an install the server
 * holds no app for).
 */
export async function deleteAppForGood(install: Install, confirm: string): Promise<void> {
  await request(address(install, "data"), { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ confirm }) });
}

/** POST .../move: moves an app with its data to another space. No body comes back. */
export async function moveAppToSpace(install: Install, body: MoveAppRequest): Promise<void> {
  await request(address(install, "move"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** PATCH .../me: the person's own switch and pin for the app. No body comes back. */
export async function patchAppPrefs(install: Install, patch: AppPrefsPatch): Promise<void> {
  await request(address(install, "me"), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) });
}
