import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type CryptoKey,
  type JWTPayload,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { cloudflareAccess } from "./cloudflare-access";
import type { Identify } from "./identify";

const TEAM_DOMAIN = "team.example.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "0123456789abcdef";
const KEY_ID = "test-key";

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let identify: Identify;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  identify = cloudflareAccess({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    keys: createLocalJWKSet({ keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] }),
  });
});

type TokenOptions = {
  claims?: JWTPayload;
  issuer?: string;
  audience?: string;
  expiresAt?: number | null;
  key?: CryptoKey;
};

const now = () => Math.floor(Date.now() / 1000);

async function token(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ email: "sam@example.com", ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(now() - 60);
  if (options.expiresAt !== null) jwt.setExpirationTime(options.expiresAt ?? now() + 3600);
  return jwt.sign(options.key ?? privateKey);
}

const request = (headers: Record<string, string> = {}) =>
  new Request("https://hearth.example.com/api/session", { headers });

describe("cloudflareAccess", () => {
  it("accepts a valid token in the header and takes the email from it", async () => {
    const result = await identify(request({ "Cf-Access-Jwt-Assertion": await token() }));
    expect(result).toEqual({ email: "sam@example.com" });
  });

  it("lower-cases the email", async () => {
    const jwt = await token({ claims: { email: "Sam@Example.COM" } });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toEqual({
      email: "sam@example.com",
    });
  });

  it("falls back to the CF_Authorization cookie", async () => {
    const result = await identify(
      request({ Cookie: `theme=dark; CF_Authorization=${await token()}; other=1` }),
    );
    expect(result).toEqual({ email: "sam@example.com" });
  });

  it("returns null when there is no token", async () => {
    expect(await identify(request())).toBeNull();
    expect(await identify(request({ Cookie: "theme=dark" }))).toBeNull();
  });

  it("never trusts a plain email header", async () => {
    expect(
      await identify(
        request({
          "Cf-Access-Authenticated-User-Email": "sam@example.com",
          "X-Forwarded-Email": "sam@example.com",
        }),
      ),
    ).toBeNull();
  });

  it("refuses the wrong audience", async () => {
    const jwt = await token({ audience: "another-application" });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
  });

  it("refuses the wrong issuer", async () => {
    const jwt = await token({ issuer: "https://other-team.example.com" });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
  });

  it("refuses an expired token", async () => {
    const jwt = await token({ expiresAt: now() - 30 });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
  });

  it("refuses a token that never expires", async () => {
    const jwt = await token({ expiresAt: null });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
  });

  it("refuses a token signed with another key", async () => {
    const jwt = await token({ key: otherPrivateKey });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
  });

  it("refuses a token that has been altered", async () => {
    const [header, , signature] = (await token()).split(".");
    const payload = Buffer.from(
      JSON.stringify({
        email: "owner@example.com",
        iss: ISSUER,
        aud: AUDIENCE,
        exp: now() + 3600,
      }),
    ).toString("base64url");
    const forged = `${header}.${payload}.${signature}`;
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": forged }))).toBeNull();
  });

  it("refuses unsigned tokens and other algorithms", async () => {
    const unsigned = new UnsecuredJWT({ email: "sam@example.com" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(now() + 3600)
      .encode();
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": unsigned }))).toBeNull();

    const symmetric = await new SignJWT({ email: "sam@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: KEY_ID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(now() + 3600)
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough"));
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": symmetric }))).toBeNull();
  });

  it("refuses text that is not a token", async () => {
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": "not-a-token" }))).toBeNull();
    expect(await identify(request({ Cookie: "CF_Authorization=a.b.c" }))).toBeNull();
  });

  it("refuses a token without an email, such as a service token", async () => {
    const jwt = await token({ claims: { email: undefined, common_name: "service.example" } });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": jwt }))).toBeNull();
    const odd = await token({ claims: { email: ["sam@example.com"] } });
    expect(await identify(request({ "Cf-Access-Jwt-Assertion": odd }))).toBeNull();
  });

  it("does not use the cookie when the header holds a bad token", async () => {
    const result = await identify(
      request({
        "Cf-Access-Jwt-Assertion": await token({ audience: "another-application" }),
        Cookie: `CF_Authorization=${await token()}`,
      }),
    );
    expect(result).toBeNull();
  });

  it("throws, instead of saying no, when the keys cannot be fetched", async () => {
    const unreachable = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      keys: async () => {
        throw new Error("network is down");
      },
    });
    await expect(
      unreachable(request({ "Cf-Access-Jwt-Assertion": await token() })),
    ).rejects.toThrow("network is down");
  });
});
