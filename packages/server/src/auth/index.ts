import type { AuthConfig } from "../config";
import { cloudflareAccess } from "./cloudflare-access";
import { dev } from "./dev";
import type { Identify } from "./identify";

export type { Identify, Identity } from "./identify";
export { cloudflareAccess } from "./cloudflare-access";
export { dev } from "./dev";

/** The login method the configuration asks for. */
export function identifyFromConfig(auth: AuthConfig): Identify {
  switch (auth.mode) {
    case "cloudflare-access":
      return cloudflareAccess({ teamDomain: auth.teamDomain, audience: auth.audience });
    case "dev":
      return dev(auth.devUser);
  }
}
