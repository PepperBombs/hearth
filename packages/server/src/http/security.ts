import type { MiddlewareHandler } from "hono";
import { isLoopbackHost } from "../config";
import { apiError } from "./errors";

/**
 * The web app is self-contained: its scripts, fonts and images come from this
 * server and it calls only this server. Inline scripts are not allowed.
 * Inline styles are, because interface libraries set them at run time.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // For browsers that do not honour frame-ancestors.
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Sets the security headers on every response, including errors and static files. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  };
}

/** Answers under /api depend on who is asking and must never be stored by a cache. */
export function noStore(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export type SameOriginOptions = {
  /**
   * Also accept requests from pages served on this machine at another port.
   * For development, where the web app is served by its own dev server.
   */
  allowLoopbackOrigins?: boolean;
};

/**
 * Refuses requests that change something and were sent by a page on another
 * site. Browsers attach the Origin header to such requests; it must name the
 * same host the request was addressed to.
 *
 * A request with neither Origin nor Sec-Fetch-Site did not come from a
 * browser page (a script or curl), cannot ride on someone's browser session,
 * and is let through to be authenticated like any other.
 */
export function sameOrigin(options: SameOriginOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const refuse = () =>
      apiError(c, 403, "invalid_request", "This request came from another site and was refused.");

    const origin = c.req.header("origin");
    if (origin === undefined) {
      const site = c.req.header("sec-fetch-site");
      if (site === undefined || site === "same-origin" || site === "none") return next();
      return refuse();
    }

    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      // Includes "null", which sandboxed and privacy-sensitive contexts send.
      return refuse();
    }
    const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase();
    if (originUrl.host.toLowerCase() === host) return next();
    if (options.allowLoopbackOrigins && isLoopbackHost(originUrl.hostname)) return next();
    return refuse();
  };
}
