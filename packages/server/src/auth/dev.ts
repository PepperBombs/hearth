import type { Identify } from "./identify";

/**
 * Development only: every request is from the configured user, unchecked.
 * The configuration refuses this mode unless the server listens on a loopback address.
 */
export function dev(email: string): Identify {
  const identity = { email: email.trim().toLowerCase() };
  return async () => ({ ...identity });
}
