import type { Locale, User } from "@hearth/shared";
import type { Db } from "./db/database";
import {
  createUserWithPersonalSpace,
  deleteInvitation,
  findUserByEmail,
  hasInvitation,
} from "./db/people";
import { normaliseEmail } from "./email";

/**
 * The interface language for a new person: Chinese if their browser ranks
 * Chinese above English, otherwise English.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return "en";
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return {
        language: tag.trim().toLowerCase().split("-")[0],
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  const first = ranked.find((entry) => entry.language === "zh" || entry.language === "en");
  return first?.language === "zh" ? "zh" : "en";
}

/**
 * Finds the user for a verified email address, creating them on first sight
 * if they are the owner or hold an invitation. Returns null for everyone
 * else: they are signed in, but not a member of this server. An address
 * Hearth does not accept (see normaliseEmail) is nobody's.
 */
export function resolveMember(
  db: Db,
  input: { email: string; ownerEmail: string; acceptLanguage?: string | null },
): User | null {
  const email = normaliseEmail(input.email);
  if (!email) return null;
  // The usual case, and a plain read: no write lock is taken.
  const known = findUserByEmail(db, email);
  if (known) return known;

  return db
    .transaction((): User | null => {
      const existing = findUserByEmail(db, email);
      if (existing) return existing;

      const isOwner = email === normaliseEmail(input.ownerEmail);
      if (!isOwner && !hasInvitation(db, email)) return null;

      const user = createUserWithPersonalSpace(db, {
        email,
        locale: localeFromAcceptLanguage(input.acceptLanguage),
      });
      deleteInvitation(db, email);
      return user;
    })
    .immediate();
}
