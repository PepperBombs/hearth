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

/**
 * A person's role in a space. Owners manage members and what they can access.
 * A personal space has one member, its owner. A group may have several owners
 * and always keeps at least one.
 */
export const SPACE_ROLES = ["owner", "member"] as const;
export const spaceRoleSchema = z.enum(SPACE_ROLES);
export type SpaceRole = z.infer<typeof spaceRoleSchema>;

/** What a person may do with one app in one space. Someone with no access never hears of the app. */
export const ACCESS_LEVELS = ["view", "edit"] as const;
export const accessLevelSchema = z.enum(ACCESS_LEVELS);
export type AccessLevel = z.infer<typeof accessLevelSchema>;

/**
 * What an owner grants: to all members of a group for one app, or to one
 * member as an exception. "none" hides the app. Owners always have "edit".
 */
export const MEMBER_ACCESS_LEVELS = ["none", ...ACCESS_LEVELS] as const;
export const memberAccessSchema = z.enum(MEMBER_ACCESS_LEVELS);
export type MemberAccess = z.infer<typeof memberAccessSchema>;

/**
 * Dashboard card sizes on the four-column grid: 1x1, 2x1, 1x2 and 2x2. The
 * same names as WIDGET_SIZES in @hearth/sdk, where a manifest picks one; a
 * test in the web app fails if the two lists differ.
 */
export const WIDGET_SIZES = ["small", "wide", "tall", "large"] as const;
export const widgetSizeSchema = z.enum(WIDGET_SIZES);
export type WidgetSize = z.infer<typeof widgetSizeSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  locale: localeSchema,
  theme: themeSchema,
});
export type User = z.infer<typeof userSchema>;

/** Someone in a space, as the other people in it see them: no email address. */
export const spaceMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: spaceRoleSchema,
});
export type SpaceMember = z.infer<typeof spaceMemberSchema>;

/** A space as one of its members sees it. */
export const spaceSchema = z.object({
  id: z.string(),
  kind: spaceKindSchema,
  /** Empty for a personal space; the interface shows a translated "Personal" label instead. */
  name: z.string(),
  /** The role of the person the session is for. */
  role: spaceRoleSchema,
  /** Whether that person may add apps here: every owner, and members an owner has allowed to. */
  canAddApps: z.boolean(),
  /** Everyone in the space, that person included, in the order they joined. */
  members: z.array(spaceMemberSchema),
});
export type Space = z.infer<typeof spaceSchema>;

/**
 * One mini-app as a person sees it in one space. Apps the person has no
 * access to are not listed at all, nor are apps that were removed from the
 * space or whose code the server does not hold.
 */
export const appSummarySchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  name: z.object({ en: z.string(), zh: z.string() }),
  description: z.object({ en: z.string(), zh: z.string() }),
  /** Icon name from the shared icon set. */
  icon: z.string(),
  /** One of the app colour tokens, for example "green". */
  color: z.string(),
  /** The size of the app's card on the dashboard. */
  widgetSize: widgetSizeSchema,
  /** What this person may do with the app here. With "view", nothing in it can be changed. */
  access: accessLevelSchema,
  /** The person's own switch. A switched-off app stays listed so that it can be switched back on. */
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
  /**
   * Whether this person may create a group, and whether they may add someone
   * to a group who is not on this server yet. For now that is the server's
   * owner alone; the interface reads these instead of deciding for itself, so
   * that the rule can change on the server.
   */
  canCreateGroups: z.boolean(),
  canInvitePeople: z.boolean(),
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
  /** Signed in and a member, but not allowed to do this, for example to change an app they may only view. */
  "forbidden",
  "invalid_request",
  /** Also the answer for an app or a space the person may not see, so that its existence is not revealed. */
  "not_found",
  /** The request is well formed but cannot be carried out as things stand, for example moving an app to a space that already has it. */
  "conflict",
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

/* -------------------------------------------------------------------------
 * Spaces, members and apps in a space (docs/mini-app-contract.md, section A8)
 *
 * The shapes below are agreed before the routes that use them are built.
 * Until a route exists, the server answers 404 for it.
 *
 * Request bodies refuse properties they do not know, so a misspelt one is an
 * error and not silently ignored. Where a route has no response schema here,
 * its body is not part of the contract: the web app reloads the session
 * instead of reading it.
 * ---------------------------------------------------------------------- */

const spaceNameSchema = z.string().trim().min(1).max(80);

/** POST /api/spaces: create a group. The caller becomes its first owner. Answers with `spaceSchema`. */
export const createSpaceRequestSchema = z.strictObject({ name: spaceNameSchema });
export type CreateSpaceRequest = z.infer<typeof createSpaceRequestSchema>;

/** PATCH /api/spaces/:spaceId. Owners only. */
export const spacePatchSchema = z.strictObject({ name: spaceNameSchema }).partial();
export type SpacePatch = z.infer<typeof spacePatchSchema>;

/**
 * POST /api/spaces/:spaceId/members. Owners only.
 *
 * Someone already on the server becomes a member at once. Anyone else is
 * invited, if the caller may invite people, and becomes a member with this
 * role when they first arrive. The server decides whether the address is one
 * it accepts and stores it in its one spelling.
 */
export const addMemberRequestSchema = z.strictObject({
  email: z.string().trim().min(1).max(254),
  /** Left out: "member". */
  role: spaceRoleSchema.optional(),
  /** Left out: false. An owner may add apps whatever this says. */
  canAddApps: z.boolean().optional(),
});
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>;

/** What became of the address: "added" as a member now, or "invited" until they first arrive. */
export const addMemberResponseSchema = z.object({ outcome: z.enum(["added", "invited"]) });
export type AddMemberResponse = z.infer<typeof addMemberResponseSchema>;

/**
 * PATCH /api/spaces/:spaceId/members/:userId. Owners only. Taking "owner"
 * away from the last owner of a space answers 409 `conflict`.
 *
 * DELETE on the same address (an owner, or the member themselves) has no
 * body; the last owner cannot be removed either.
 */
export const memberPatchSchema = z
  .strictObject({ role: spaceRoleSchema, canAddApps: z.boolean() })
  .partial();
export type MemberPatch = z.infer<typeof memberPatchSchema>;

/**
 * PUT /api/spaces/:spaceId/apps/:appId: add an app to a space, or bring a
 * removed one back with its data. Owners, and members who may add apps; only
 * an owner may bring a removed app back. Answers 204 with no body.
 *
 * An app that is already in the space is left as it is, and that is not an
 * error, unless `memberAccess` asks for something else than it has: that
 * answers 409 `conflict`, because access is changed through its own route.
 * 409 is also the answer for an app whose manifest does not allow this kind
 * of space, and for a member adding an app that the space has an entry for
 * which they cannot see.
 */
export const addAppRequestSchema = z.strictObject({
  /**
   * What the other members of a group get: "none" (only the person adding
   * it, and the owners), "view" or "edit". Left out: "none". It applies when
   * the app is added and when it is brought back, where access starts
   * afresh: exceptions made for single members before the removal are gone.
   */
  memberAccess: memberAccessSchema.optional(),
});
export type AddAppRequest = z.infer<typeof addAppRequestSchema>;

/**
 * DELETE /api/spaces/:spaceId/apps/:appId/data. Owners only, and only for an
 * app that was removed or whose code is gone; for one still in use the
 * answer is 409 `conflict`. `confirm` is the app's ID, typed by the person.
 * Answers 204 with no body.
 *
 * DELETE /api/spaces/:spaceId/apps/:appId, which removes the app and keeps
 * its data, has no body. Owners only.
 */
export const deleteAppDataRequestSchema = z.strictObject({ confirm: z.string() });
export type DeleteAppDataRequest = z.infer<typeof deleteAppDataRequestSchema>;

/** POST /api/spaces/:spaceId/apps/:appId/move: move an app and its data to another space. */
export const moveAppRequestSchema = z.strictObject({
  toSpaceId: z.string().min(1),
  /** What the members of the target get. Left out: "none", so a move never widens access by itself. */
  memberAccess: memberAccessSchema.optional(),
});
export type MoveAppRequest = z.infer<typeof moveAppRequestSchema>;

/** PUT /api/spaces/:spaceId/apps/:appId/access. Owners only. What is left out stays as it is. */
export const appAccessRequestSchema = z.strictObject({
  /** What every member gets who has no exception. */
  memberAccess: memberAccessSchema.optional(),
  /** Exceptions by user ID. `null` removes one, so that the person follows `memberAccess` again. */
  members: z.record(z.string(), memberAccessSchema.nullable()).optional(),
});
export type AppAccessRequest = z.infer<typeof appAccessRequestSchema>;

/** PATCH /api/spaces/:spaceId/apps/:appId/me: the caller's own switch and pin. */
export const appPrefsPatchSchema = z
  .strictObject({ enabled: z.boolean(), pinned: z.boolean() })
  .partial();
export type AppPrefsPatch = z.infer<typeof appPrefsPatchSchema>;

/** A member as the owners of a space see them. */
export const spaceMemberDetailSchema = spaceMemberSchema.extend({
  email: z.string(),
  canAddApps: z.boolean(),
});
export type SpaceMemberDetail = z.infer<typeof spaceMemberDetailSchema>;

/** Someone added to a group who has not arrived on the server yet. */
export const spaceInvitationSchema = z.object({
  email: z.string(),
  role: spaceRoleSchema,
  canAddApps: z.boolean(),
});
export type SpaceInvitation = z.infer<typeof spaceInvitationSchema>;

/**
 * An app in a space as its owners see it. Unlike `AppSummary` this includes
 * apps that were removed and apps whose code is no longer on the server,
 * which is why it has an ID but no name: the web app takes the name from the
 * manifest it holds, and shows the ID when it holds none.
 */
export const installedAppSchema = z.object({
  id: z.string(),
  /** False when the server holds no code for this ID, for example after its folder was deleted. */
  hasCode: z.boolean(),
  /** When the app was removed from the space, or null while it is there. Its data is kept either way. */
  removedAt: z.string().nullable(),
  /** How many rows of data the app holds in this space. */
  rowCount: z.number().int().nonnegative(),
  memberAccess: memberAccessSchema,
  /** Exceptions by user ID; a member not listed follows `memberAccess`. */
  members: z.record(z.string(), memberAccessSchema),
});
export type InstalledApp = z.infer<typeof installedAppSchema>;

/** GET /api/spaces/:spaceId/apps. Owners only. */
export const spaceAppsSchema = z.object({
  apps: z.array(installedAppSchema),
  members: z.array(spaceMemberDetailSchema),
  invitations: z.array(spaceInvitationSchema),
});
export type SpaceApps = z.infer<typeof spaceAppsSchema>;

/** The value of one app setting: text, a number, a switch, or a list of texts. */
export const settingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type SettingValue = z.infer<typeof settingValueSchema>;

const settingValuesSchema = z.record(z.string(), settingValueSchema);

/**
 * GET /api/spaces/:spaceId/apps/:appId/settings, and the answer to the PATCH
 * below. Every setting the manifest declares is present, with its default
 * where nothing was saved: `space` holds the values shared by everyone in the
 * space, `user` the caller's own.
 */
export const appSettingsSchema = z.object({
  space: settingValuesSchema,
  user: settingValuesSchema,
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * PATCH /api/spaces/:spaceId/apps/:appId/settings. Only the settings named
 * are changed. Changing `space` needs edit access; `user` needs only view.
 * The server checks names and values against the app's manifest.
 */
export const appSettingsPatchSchema = z
  .strictObject({ space: settingValuesSchema, user: settingValuesSchema })
  .partial();
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

/**
 * POST /api/spaces/:spaceId/apps/:appId/q/:name (a query; needs view) and
 * .../m/:name (a mutation; needs edit). `input` is whatever the app's route
 * takes and is left out for a route that takes nothing; the app's own schema
 * checks it.
 */
export const appCallRequestSchema = z.strictObject({ input: z.json().optional() });
export type AppCallRequest = z.infer<typeof appCallRequestSchema>;

/** The answer to a query or mutation. `output` is left out when the route returns nothing. */
export const appCallResponseSchema = z.object({ output: z.json().optional() });
export type AppCallResponse = z.infer<typeof appCallResponseSchema>;
