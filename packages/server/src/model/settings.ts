/**
 * Each person's own model (docs/platform.md, "Your own model"): the table
 * `user_models`, and the sealing of their key.
 *
 * The key is sealed with AES-256-GCM under a key derived from the server's
 * secret (HEARTH_SECRET), and opened only to call the model. No answer of
 * the server ever holds it: what the person reads back is whether one is
 * saved.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ModelProtocol, ModelSettings, ModelSettingsRequest } from "@hearth/shared";
import type { Config } from "../config";
import type { Db } from "../db/database";
import { Refusal } from "../http/errors";

/** A dev server without a secret makes one up, which lasts until it stops: keys saved there go with it. */
const DEV_SECRET = randomBytes(32).toString("base64");

/** The secret that seals keys on this server, or null when it has none and may not make one up. */
export function sealingSecret(config: Pick<Config, "secret" | "auth">): string | null {
  return config.secret ?? (config.auth.mode === "dev" ? DEV_SECRET : null);
}

const VERSION = "v1";

function sealingKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "hearth", "hearth model keys v1", 32));
}

export function sealKey(secret: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(secret), iv);
  const sealed = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")}`;
}

/** The key, or null when it was sealed under another secret or is damaged. */
export function openKey(secret: string, sealed: string): string | null {
  const [version, payload] = sealed.split(":");
  if (version !== VERSION || payload === undefined) return null;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < 29) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(secret), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Names that only a local network knows. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;

/**
 * Where a model may be: an https address on a public name. The server asks
 * it with the person's key and shows them what it answers, so it must not
 * be one of the server's own neighbours: no address of the local network,
 * no IP address at all, no sign-in or query in the address.
 */
export function checkBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (!host.includes(".") || LOCAL_NAME.test(host)) return null;
  // Every label of a public name holds a letter somewhere; an IPv4 address has none, IPv6 has brackets.
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

type ModelRow = { protocol: ModelProtocol; baseUrl: string; model: string; sealedKey: string | null };

function readRow(db: Db, userId: string): ModelRow | null {
  const row = db
    .prepare(
      `SELECT protocol, base_url AS baseUrl, model, sealed_key AS sealedKey
         FROM user_models
        WHERE user_id = ?`,
    )
    .get(userId) as ModelRow | undefined;
  return row ?? null;
}

/** What the person saved, as they may read it back: no key. */
export function readModelSettings(db: Db, userId: string): ModelSettings | null {
  const row = readRow(db, userId);
  return row ? { protocol: row.protocol, baseUrl: row.baseUrl, model: row.model, hasKey: row.sealedKey !== null } : null;
}

/** Everything needed to call the person's model, key opened, or why it cannot be called. */
export type ModelAccess =
  | { ok: true; protocol: ModelProtocol; baseUrl: string; model: string; apiKey: string }
  | { ok: false; failure: "no_model" | "no_key" | "no_secret" };

export function modelAccess(db: Db, config: Pick<Config, "secret" | "auth">, userId: string): ModelAccess {
  const row = readRow(db, userId);
  if (!row) return { ok: false, failure: "no_model" };
  if (row.sealedKey === null) return { ok: false, failure: "no_key" };
  const secret = sealingSecret(config);
  if (secret === null) return { ok: false, failure: "no_secret" };
  // Sealed under another secret: as good as none, and the person is asked for it again.
  const apiKey = openKey(secret, row.sealedKey);
  if (apiKey === null) return { ok: false, failure: "no_key" };
  return { ok: true, protocol: row.protocol, baseUrl: row.baseUrl, model: row.model, apiKey };
}

/**
 * Saves the person's model. Without a key in the request the one saved
 * before stays, unless the address changed: a key goes only to the
 * address it was given for.
 */
export function saveModelSettings(
  db: Db,
  config: Pick<Config, "secret" | "auth">,
  userId: string,
  request: ModelSettingsRequest,
): ModelSettings {
  const baseUrl = checkBaseUrl(request.baseUrl);
  if (baseUrl === null) {
    throw new Refusal(
      400,
      "invalid_request",
      "The address must start with https:// and name a public host, for example https://api.deepseek.com.",
    );
  }
  const before = readRow(db, userId);
  let sealedKey = before !== null && before.baseUrl === baseUrl ? before.sealedKey : null;
  if (request.apiKey !== undefined) {
    const secret = sealingSecret(config);
    if (secret === null) {
      throw new Refusal(409, "conflict", "This server has no HEARTH_SECRET, so it cannot keep a key. Its owner sets one.");
    }
    sealedKey = sealKey(secret, request.apiKey);
  }
  db.prepare(
    `INSERT INTO user_models (user_id, protocol, base_url, model, sealed_key, updated_at)
     VALUES (@userId, @protocol, @baseUrl, @model, @sealedKey, @now)
     ON CONFLICT (user_id) DO UPDATE SET
       protocol = excluded.protocol, base_url = excluded.base_url, model = excluded.model,
       sealed_key = excluded.sealed_key, updated_at = excluded.updated_at`,
  ).run({ userId, protocol: request.protocol, baseUrl, model: request.model, sealedKey, now: new Date().toISOString() });
  return readModelSettings(db, userId)!;
}

export function deleteModelSettings(db: Db, userId: string): void {
  db.prepare("DELETE FROM user_models WHERE user_id = ?").run(userId);
}
