import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Identify } from "./identify";

export type CloudflareAccessOptions = {
  /** For example "your-team.cloudflareaccess.com". */
  teamDomain: string;
  /** The Application Audience (AUD) tag of the Access application. */
  audience: string;
  /** Resolves the signing key. Defaults to the team's published keys; tests pass a local one. */
  keys?: JWTVerifyGetKey;
};

const HEADER = "cf-access-jwt-assertion";
const COOKIE = "CF_Authorization";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

/** Failures that mean "this token is not acceptable", as opposed to "we could not check". */
function isRejection(error: unknown): boolean {
  return (
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  );
}

/**
 * Identity from Cloudflare Access, which sits in front of the server and
 * signs a JWT into every request it lets through.
 *
 * The token is verified here (signature, issuer, audience, expiry) and the
 * email is taken from it. Plain headers such as
 * Cf-Access-Authenticated-User-Email are never read: anyone who can reach the
 * server directly could set them.
 */
export function cloudflareAccess(options: CloudflareAccessOptions): Identify {
  const issuer = `https://${options.teamDomain}`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async (request) => {
    const token = request.headers.get(HEADER)?.trim() || readCookie(request, COOKIE);
    if (!token) return null;

    let email: unknown;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp"],
      });
      email = payload.email;
    } catch (error) {
      if (isRejection(error)) return null;
      throw error;
    }

    // Service tokens carry no email; they are not people and are not let in.
    if (typeof email !== "string") return null;
    const normalised = email.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+$/.test(normalised) ? { email: normalised } : null;
  };
}
