/**
 * How the web app talks to the server, and the two calls the shell makes for
 * itself. Shapes come from @hearth/shared, which is the contract with the
 * server; responses are checked against it before use. The calls made for a
 * mini-app are in ../apps/api.ts and go through `request` too.
 */
import { apiErrorSchema, sessionSchema, type ApiErrorCode, type PreferencesPatch, type Session } from "@hearth/shared";

/** Why a request failed. The first two never reach the server's own error codes. */
export type FailureCode = ApiErrorCode | "network" | "invalid_response";

export class ApiRequestError extends Error {
  readonly code: FailureCode;
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;

  constructor(code: FailureCode, status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export function failureCode(error: unknown): FailureCode {
  return error instanceof ApiRequestError ? error.code : "internal";
}

function codeForStatus(status: number): FailureCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid_request";
  return "internal";
}

/**
 * Sends one request. Resolves with the response when the server answered
 * with success; anything else rejects with an `ApiRequestError` that carries
 * the server's error code, or "network" when no answer came.
 */
export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // Also the outcome when an expired sign-in redirects the request to another site.
    throw new ApiRequestError("network", 0, "The server could not be reached.");
  }
  if (response.ok) return response;

  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) throw new ApiRequestError(parsed.data.error.code, response.status, parsed.data.error.message);
  throw new ApiRequestError(codeForStatus(response.status), response.status, `Request failed with status ${response.status}.`);
}

/** GET /api/session */
export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const response = await request("/api/session", { signal });
  const body: unknown = await response.json().catch(() => null);
  const parsed = sessionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRequestError("invalid_response", response.status, "The session did not match the expected shape.");
  }
  return parsed.data;
}

/** PATCH /api/me. The response body is not part of the contract, so it is not read. */
export async function patchPreferences(patch: PreferencesPatch): Promise<void> {
  await request("/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}
