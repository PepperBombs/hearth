/**
 * Types and schemas shared by the server and the web app.
 * This file is the contract between them: change it first, then both sides.
 */
import { z } from "zod";

export const LOCALES = ["en", "zh"] as const;
export const localeSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof localeSchema>;

export const THEMES = ["light", "dark", "system"] as const;
export const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;

/** Text supplied in every supported language, such as an app's name. */
export type Localized = Record<Locale, string>;

/** A space owns data. Each person has one personal space; a group space is a family or team. */
export const spaceKindSchema = z.enum(["personal", "group"]);
export type SpaceKind = z.infer<typeof spaceKindSchema>;

/** A person's role in a space. The owner manages members and what they can access. */
export const spaceRoleSchema = z.enum(["owner", "member"]);
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  locale: localeSchema,
  theme: themeSchema,
});
export type User = z.infer<typeof userSchema>;

export const spaceSchema = z.object({
  id: z.string(),
  kind: spaceKindSchema,
  /** Empty for a personal space; the interface shows a translated "Personal" label instead. */
  name: z.string(),
  role: spaceRoleSchema,
});
export type Space = z.infer<typeof spaceSchema>;

/** One mini-app as a person sees it in one space. The list is empty until the mini-app contract lands. */
export const appSummarySchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  name: z.object({ en: z.string(), zh: z.string() }),
  description: z.object({ en: z.string(), zh: z.string() }),
  /** Icon name from the shared icon set. */
  icon: z.string(),
  /** One of the app colour tokens, for example "green". */
  color: z.string(),
  enabled: z.boolean(),
  pinned: z.boolean(),
  hasPage: z.boolean(),
});
export type AppSummary = z.infer<typeof appSummarySchema>;

/** GET /api/session */
export const sessionSchema = z.object({
  user: userSchema,
  spaces: z.array(spaceSchema),
  apps: z.array(appSummarySchema),
  /** Short commit hash of the running build, or "dev". */
  version: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

/** PATCH /api/me */
export const preferencesPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    locale: localeSchema,
    theme: themeSchema,
  })
  .partial()
  .strict();
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

export const API_ERROR_CODES = [
  "unauthenticated",
  "not_a_member",
  "invalid_request",
  "not_found",
  "internal",
] as const;
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError["error"]["code"];

/** GET /api/health */
export const healthSchema = z.object({ ok: z.literal(true), version: z.string() });
export type Health = z.infer<typeof healthSchema>;
