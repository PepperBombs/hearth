import {
  apiErrorSchema,
  healthSchema,
  sessionSchema,
  userSchema,
  type ApiErrorCode,
} from "@hearth/shared";
import { describe, expect, it } from "vitest";
import { addInvitation, findUserByEmail } from "./db/people";
import { CONTENT_SECURITY_POLICY } from "./http/security";
import { as, OWNER_EMAIL, testApp, testConfig } from "./testing";

const BASE = "http://hearth.example.com";
/** Dev mode answers only requests addressed to this machine. */
const LOCAL = "http://127.0.0.1:4310";

async function expectError(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

function patchMe(
  app: ReturnType<typeof testApp>["app"],
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`${BASE}/api/me`, {
    method: "PATCH",
    headers: as(OWNER_EMAIL, { "content-type": "application/json", ...headers }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/health", () => {
  it("answers without sign-in", async () => {
    const { app } = testApp();
    const response = await app.request(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    expect(healthSchema.parse(await response.json())).toEqual({ ok: true, version: "test" });
  });
});

describe("membership", () => {
  it("answers 401 when the request carries no identity", async () => {
    const { app, db } = testApp();
    await expectError(await app.request(`${BASE}/api/session`), 401, "unauthenticated");
    await expectError(
      await app.request(`${BASE}/api/me`, { method: "PATCH", body: "{}" }),
      401,
      "unauthenticated",
    );
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("creates the owner on first sight", async () => {
    const { app, db } = testApp();
    const response = await app.request(`${BASE}/api/session`, { headers: as(OWNER_EMAIL) });
    expect(response.status).toBe(200);
    expect(findUserByEmail(db, OWNER_EMAIL)).not.toBeNull();
  });

  it("answers 403 to a stranger", async () => {
    const { app, db } = testApp();
    await expectError(
      await app.request(`${BASE}/api/session`, { headers: as("stranger@example.com") }),
      403,
      "not_a_member",
    );
    expect(findUserByEmail(db, "stranger@example.com")).toBeNull();
  });

  it("creates an invited person on first sight", async () => {
    const { app, db } = testApp();
    await app.request(`${BASE}/api/session`, { headers: as(OWNER_EMAIL) });
    const owner = findUserByEmail(db, OWNER_EMAIL)!;
    addInvitation(db, { email: "lin@example.com", invitedBy: owner.id });

    const response = await app.request(`${BASE}/api/session`, {
      headers: as("Lin@Example.com", { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" }),
    });
    expect(response.status).toBe(200);
    const session = sessionSchema.parse(await response.json());
    expect(session.user).toMatchObject({ email: "lin@example.com", name: "lin", locale: "zh" });
    expect(session.spaces).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM invitations").get()).toEqual({ n: 0 });
  });

  it("uses the dev user when sign-in is switched off", async () => {
    const { app } = testApp({
      config: testConfig({ auth: { mode: "dev", devUser: OWNER_EMAIL } }),
      identify: "from-config",
    });
    const response = await app.request(`${LOCAL}/api/session`);
    expect(sessionSchema.parse(await response.json()).user.email).toBe(OWNER_EMAIL);
  });

  it("answers 401 under Cloudflare Access when there is no token, whatever plain headers say", async () => {
    const { app } = testApp({ identify: "from-config" });
    await expectError(
      await app.request(`${BASE}/api/session`, {
        headers: { "Cf-Access-Authenticated-User-Email": OWNER_EMAIL },
      }),
      401,
      "unauthenticated",
    );
  });
});

describe("GET /api/session", () => {
  it("matches the shared contract exactly", async () => {
    const { app } = testApp();
    const response = await app.request(`${BASE}/api/session`, { headers: as(OWNER_EMAIL) });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    // Strict, so that a field the contract does not name would fail too.
    const session = sessionSchema
      .extend({
        user: userSchema.strict(),
        spaces: sessionSchema.shape.spaces.element.strict().array(),
      })
      .strict()
      .parse(body);
    expect(session).toEqual({
      user: {
        id: expect.any(String),
        email: OWNER_EMAIL,
        name: "owner",
        locale: "en",
        theme: "system",
      },
      spaces: [{ id: expect.any(String), kind: "personal", name: "", role: "owner" }],
      apps: [],
      version: "test",
    });
  });
});

describe("PATCH /api/me", () => {
  it("changes preferences and returns the user", async () => {
    const { app } = testApp();
    const response = await patchMe(app, { name: "  Sam Sample  ", locale: "zh", theme: "dark" });
    expect(response.status).toBe(200);
    const user = userSchema.strict().parse(await response.json());
    expect(user).toMatchObject({ name: "Sam Sample", locale: "zh", theme: "dark" });

    const session = sessionSchema.parse(
      await (await app.request(`${BASE}/api/session`, { headers: as(OWNER_EMAIL) })).json(),
    );
    expect(session.user).toEqual(user);
  });

  it("changes only what is given", async () => {
    const { app } = testApp();
    await patchMe(app, { name: "Sam", theme: "light" });
    const user = userSchema.parse(await (await patchMe(app, { locale: "zh" })).json());
    expect(user).toMatchObject({ name: "Sam", locale: "zh", theme: "light" });
    const same = userSchema.parse(await (await patchMe(app, {})).json());
    expect(same).toEqual(user);
  });

  it("changes nobody else", async () => {
    const { app, db } = testApp();
    await app.request(`${BASE}/api/session`, { headers: as(OWNER_EMAIL) });
    addInvitation(db, { email: "lin@example.com", invitedBy: findUserByEmail(db, OWNER_EMAIL)!.id });
    await app.request(`${BASE}/api/session`, { headers: as("lin@example.com") });
    await patchMe(app, { name: "Renamed", theme: "dark" });
    expect(findUserByEmail(db, "lin@example.com")).toMatchObject({ name: "lin", theme: "system" });
  });

  it.each([
    ["an unknown theme", { theme: "pink" }],
    ["an unknown locale", { locale: "fr" }],
    ["an empty name", { name: "   " }],
    ["a name that is too long", { name: "x".repeat(81) }],
    ["a name that is not text", { name: 42 }],
    ["a field that cannot be changed", { email: "other@example.com" }],
    ["an unknown field", { theme: "dark", admin: true }],
    ["a list", ["dark"]],
    ["nothing", null],
    ["text that is not JSON", "{ theme: dark"],
  ])("refuses %s", async (_label, body) => {
    const { app, db } = testApp();
    await expectError(await patchMe(app, body), 400, "invalid_request");
    expect(findUserByEmail(db, OWNER_EMAIL)).toMatchObject({ name: "owner", theme: "system" });
  });

  it("refuses a body that is too large", async () => {
    const { app } = testApp();
    await expectError(
      await patchMe(app, { name: "x".repeat(100_000) }),
      413,
      "invalid_request",
    );
  });
});

describe("requests from another site", () => {
  it.each([
    ["the same host", { origin: BASE }, 200],
    ["the same host under https", { origin: "https://hearth.example.com" }, 200],
    ["no Origin at all, as from a script", {}, 200],
    ["no Origin but marked same-origin", { "sec-fetch-site": "same-origin" }, 200],
    ["another site", { origin: "https://evil.example.net" }, 403],
    ["another port", { origin: "http://hearth.example.com:8080" }, 403],
    ["a subdomain", { origin: "https://app.hearth.example.com" }, 403],
    ["a look-alike host", { origin: "https://hearth.example.com.evil.example.net" }, 403],
    ["an opaque origin", { origin: "null" }, 403],
    ["no Origin but marked cross-site", { "sec-fetch-site": "cross-site" }, 403],
    ["no Origin but marked same-site", { "sec-fetch-site": "same-site" }, 403],
    ["this machine at another port", { origin: "http://localhost:5173" }, 403],
  ] as const)("PATCH from %s -> %i", async (_label, headers, status) => {
    const { app, db } = testApp();
    const response = await patchMe(app, { theme: "dark" }, headers);
    expect(response.status).toBe(status);
    if (status === 403) {
      await expectError(response, 403, "invalid_request");
      expect(findUserByEmail(db, OWNER_EMAIL)?.theme ?? "system").toBe("system");
    }
  });

  it("compares against the Host header the request was addressed to", async () => {
    const { app } = testApp();
    const response = await app.request("http://127.0.0.1:4310/api/me", {
      method: "PATCH",
      headers: as(OWNER_EMAIL, {
        host: "hearth.example.com",
        origin: "https://hearth.example.com",
      }),
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(response.status).toBe(200);
  });

  it("is checked before sign-in and on unknown routes", async () => {
    const { app } = testApp();
    const response = await app.request(`${BASE}/api/anything`, {
      method: "POST",
      headers: { origin: "https://evil.example.net" },
    });
    await expectError(response, 403, "invalid_request");
  });

  it("does not apply to reading", async () => {
    const { app } = testApp();
    const response = await app.request(`${BASE}/api/session`, {
      headers: as(OWNER_EMAIL, { origin: "https://evil.example.net" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("accepts the web dev server on this machine in dev mode only", async () => {
    const { app } = testApp({
      config: testConfig({ auth: { mode: "dev", devUser: OWNER_EMAIL } }),
      identify: "from-config",
    });
    const patch = (origin: string) =>
      app.request(`${LOCAL}/api/me`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ theme: "dark" }),
      });
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      expect((await patch(origin)).status).toBe(200);
    }
    expect((await patch("https://evil.example.net")).status).toBe(403);
  });
});

describe("dev mode, where nobody is asked to sign in", () => {
  const devApp = () =>
    testApp({
      config: testConfig({ auth: { mode: "dev", devUser: OWNER_EMAIL } }),
      identify: "from-config",
    });

  it.each([
    "127.0.0.1:4310",
    "localhost:5173",
    "LOCALHOST",
    "[::1]:4310",
    "127.0.0.1",
  ])("answers a request addressed to %s", async (host) => {
    const { app } = devApp();
    const response = await app.request(`${LOCAL}/api/session`, { headers: { host } });
    expect(response.status).toBe(200);
  });

  // A page on any site can point its own name at 127.0.0.1 (DNS rebinding).
  it.each([
    "attacker.example:4310",
    "hearth.example.com",
    "127.0.0.1.attacker.example",
    "localhost.attacker.example:4310",
    "192.168.1.20:4310",
    "0.0.0.0:4310",
    "",
  ])("refuses a request addressed to another name: %j", async (host) => {
    const { app, db } = devApp();
    await expectError(
      await app.request(`${LOCAL}/api/session`, { headers: { host } }),
      403,
      "invalid_request",
    );
    // Reading pages is refused too, and so is a write whose Origin matches that Host.
    expect((await app.request(`${LOCAL}/`, { headers: { host } })).status).toBe(403);
    await expectError(
      await app.request(`${LOCAL}/api/me`, {
        method: "PATCH",
        headers: { host, origin: `http://${host}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "changed by another site" }),
      }),
      403,
      "invalid_request",
    );
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("goes by the address in the URL when there is no Host header", async () => {
    const { app } = devApp();
    expect((await app.request(`${LOCAL}/api/session`)).status).toBe(200);
    await expectError(await app.request(`${BASE}/api/session`), 403, "invalid_request");
  });

  it.each([
    ["Cf-Connecting-Ip", "203.0.113.9"],
    ["Cf-Ray", "8f1e2d3c4b5a6978-LHR"],
    ["X-Forwarded-For", "203.0.113.9"],
    ["X-Forwarded-Host", "hearth.example.com"],
    ["Forwarded", "for=203.0.113.9"],
    ["X-Real-Ip", "203.0.113.9"],
  ])("refuses a request passed on by a proxy or tunnel (%s)", async (name, value) => {
    const { app, db } = devApp();
    await expectError(
      await app.request(`${LOCAL}/api/session`, { headers: { [name]: value } }),
      403,
      "invalid_request",
    );
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("does not restrict the Host when sign-in is on", async () => {
    const { app } = testApp();
    const response = await app.request(`${LOCAL}/api/session`, {
      headers: as(OWNER_EMAIL, { host: "hearth.example.com", "cf-connecting-ip": "203.0.113.9" }),
    });
    expect(response.status).toBe(200);
  });
});

describe("unknown routes and errors", () => {
  it.each([
    ["GET", "/api/nothing"],
    ["GET", "/api"],
    ["GET", "/api/"],
    ["POST", "/api/session"],
    ["DELETE", "/api/me"],
    ["GET", "/api/session/extra"],
  ])("%s %s -> 404 in the error shape", async (method, path) => {
    const { app } = testApp();
    await expectError(await app.request(`${BASE}${path}`, { method }), 404, "not_found");
  });

  it("answers 404 to writes outside /api", async () => {
    const { app } = testApp();
    await expectError(await app.request(`${BASE}/`, { method: "POST" }), 404, "not_found");
  });

  it("never leaks what went wrong", async () => {
    const { app, errors } = testApp({
      identify: async () => {
        throw new Error("secret detail at /srv/private/path");
      },
    });
    const response = await app.request(`${BASE}/api/session`);
    const text = await response.clone().text();
    const error = await expectError(response, 500, "internal");
    expect(error.message).toBe("Something went wrong on the server.");
    expect(text).not.toContain("secret detail");
    expect(text).not.toContain("stack");
    expect(text).not.toMatch(/\bat\s.+:\d+/);
    expect(errors).toHaveLength(1);
  });

  it("answers 500 without detail when the database fails", async () => {
    const { app, db, errors } = testApp();
    db.exec("DROP TABLE space_members");
    const response = await app.request(`${BASE}/api/session`, { headers: as(OWNER_EMAIL) });
    const text = await response.clone().text();
    await expectError(response, 500, "internal");
    expect(text).not.toContain("space_members");
    expect(errors).toHaveLength(1);
  });
});

describe("security headers", () => {
  it.each([
    ["a successful answer", "GET", "/api/health", {}],
    ["a 401", "GET", "/api/session", {}],
    ["a 404", "GET", "/api/nothing", {}],
    ["a refused cross-site request", "POST", "/api/me", { origin: "https://evil.example.net" }],
    ["the web app", "GET", "/", {}],
    ["a write outside /api", "PUT", "/somewhere", {}],
  ] as const)("are on %s", async (_label, method, path, headers) => {
    const { app } = testApp();
    const response = await app.request(`${BASE}${path}`, { method, headers });
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("are on a 500", async () => {
    const { app } = testApp({
      identify: async () => {
        throw new Error("boom");
      },
    });
    const response = await app.request(`${BASE}/api/session`);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("forbid inline and foreign scripts, plug-ins and framing", () => {
    const policy = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
        const [name, ...values] = directive.split(" ");
        return [name, values];
      }),
    );
    expect(policy["default-src"]).toEqual(["'self'"]);
    expect(policy["script-src"]).toEqual(["'self'"]);
    expect(policy["font-src"]).toEqual(["'self'"]);
    expect(policy["connect-src"]).toEqual(["'self'"]);
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["frame-ancestors"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
  });
});
