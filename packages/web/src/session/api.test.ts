import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@hearth/shared";
import { ApiRequestError, failureCode, fetchSession, patchPreferences } from "./api";

const session: Session = {
  user: { id: "u1", email: "sam@example.com", name: "Sam Example", locale: "en", theme: "system" },
  spaces: [
    { id: "s1", kind: "personal", name: "", role: "owner", canAddApps: true, members: [{ id: "u1", name: "Sam Example", role: "owner" }] },
  ],
  apps: [],
  canCreateGroups: false,
  canInvitePeople: false,
  version: "dev",
};

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchSession", () => {
  it("returns a session that matches the contract", async () => {
    const fetchMock = respondWith(200, session);
    await expect(fetchSession()).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith("/api/session", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("reports the server's error code, such as not_a_member", async () => {
    respondWith(403, { error: { code: "not_a_member", message: "Ask the owner for an invitation." } });
    const error = await fetchSession().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(failureCode(error)).toBe("not_a_member");
    expect((error as ApiRequestError).status).toBe(403);
  });

  it("copes with an error that is not in the contract's shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    expect(failureCode(await fetchSession().catch((caught: unknown) => caught))).toBe("internal");
    respondWith(401, { nope: true });
    expect(failureCode(await fetchSession().catch((caught: unknown) => caught))).toBe("unauthenticated");
  });

  it("rejects a 200 whose body is not a session", async () => {
    respondWith(200, { user: { id: "u1" } });
    expect(failureCode(await fetchSession().catch((caught: unknown) => caught))).toBe("invalid_response");
  });

  it("reports an unreachable server as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const error = await fetchSession().catch((caught: unknown) => caught);
    expect(failureCode(error)).toBe("network");
    expect((error as ApiRequestError).status).toBe(0);
  });
});

describe("patchPreferences", () => {
  it("sends the change as JSON with PATCH", async () => {
    const fetchMock = respondWith(200, {});
    await patchPreferences({ theme: "dark" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ theme: "dark" }) }),
    );
  });

  it("rejects when the server refuses", async () => {
    respondWith(400, { error: { code: "invalid_request", message: "Sample failure" } });
    await expect(patchPreferences({ name: "x" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("failureCode", () => {
  it("treats anything unexpected as an internal failure", () => {
    expect(failureCode(new Error("boom"))).toBe("internal");
  });
});
