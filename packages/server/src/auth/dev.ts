import { normaliseEmail } from "../email";
import type { Identify } from "./identify";

/**
 * Development only: every request is from the configured user, unchecked.
 * The configuration refuses this mode unless the server listens on a
 * loopback address, and the application then refuses requests that were not
 * addressed to this machine (see loopbackOnly in http/security.ts).
 */
export function dev(email: string): Identify {
  const normalised = normaliseEmail(email);
  if (!normalised) throw new Error("The dev user must be an email address.");
  const identity = { email: normalised };
  return async () => ({ ...identity });
}
