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

/**
 * A value that survives being sent as JSON. An object may leave a property
 * undefined; it is then left out, as `JSON.stringify` does.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

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
  /**
   * What the assistant, each person's own model in the chat, may do here
   * for the people in it, as the space's owners chose: "none" (off, where
   * every space starts), "view" (read only) or "edit" (read and change). A
   * person's own access to each app still limits it (docs/platform.md,
   * "The chat").
   */
  assistant: memberAccessSchema,
});
export type Space = z.infer<typeof spaceSchema>;

/**
 * One app as a person sees it in one space. Apps the person has no access
 * to are not listed at all, nor are apps that were removed from the space
 * or that the server holds no app for.
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
  /**
   * True for an app made in Hearth (docs/platform.md), which every app the
   * server lists is: its card is a page of its own, run in a sandbox.
   */
  made: z.boolean().optional(),
  /** A made app's version in use: it changes with every change to the app, so its page is drawn afresh. */
  version: z.number().int().positive().optional(),
  /** The built-in app a made app was added from, when it was. */
  template: z.string().optional(),
  /** A made app's settings, declared as an SDK manifest declares them, for the settings dialog. */
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type AppSummary = z.infer<typeof appSummarySchema>;

/** GET /api/session */
export const sessionSchema = z.object({
  user: userSchema,
  spaces: z.array(spaceSchema),
  apps: z.array(appSummarySchema),
  /**
   * Whether this person may create a group, and whether they may add someone
   * to a group who is not on this server yet. The server decides, by one
   * policy and one setting: the server's owner alone unless that setting
   * opens both to everyone on the server. The interface reads these instead
   * of deciding for itself, so that the rule can change on the server.
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
 * The shapes below were agreed before the routes that use them were built.
 *
 * Request bodies refuse properties they do not know, so a misspelt one is an
 * error and not silently ignored. Where a route has no response schema here,
 * its body is not part of the contract: the web app reloads the session
 * instead of reading it.
 * ---------------------------------------------------------------------- */

const spaceNameSchema = z.string().trim().min(1).max(80);

/**
 * POST /api/spaces: create a group. The caller becomes its first owner.
 * Only someone the session says `canCreateGroups` may (403 `forbidden`
 * otherwise). Answers 201 with the new space as the session lists it
 * (`spaceSchema`).
 */
export const createSpaceRequestSchema = z.strictObject({ name: spaceNameSchema });
export type CreateSpaceRequest = z.infer<typeof createSpaceRequestSchema>;

/**
 * PATCH /api/spaces/:spaceId: rename a group. Owners only. A personal space
 * has no name of its own, so renaming one answers 409 `conflict`. Answers
 * 204 with no body.
 */
export const spacePatchSchema = z.strictObject({ name: spaceNameSchema }).partial();
export type SpacePatch = z.infer<typeof spacePatchSchema>;

/**
 * PUT /api/spaces/:spaceId/assistant: what an assistant may do in the space
 * (the session's `Space.assistant`). Owners only, of a personal space too;
 * 403 `forbidden` for a member, 404 for anyone else. Answers 204 with no
 * body.
 */
export const assistantLevelRequestSchema = z.strictObject({ level: memberAccessSchema });
export type AssistantLevelRequest = z.infer<typeof assistantLevelRequestSchema>;

/**
 * POST /api/spaces/:spaceId/members. Owners of a group only; a personal
 * space has no other members (409 `conflict`).
 *
 * Someone already on the server becomes a member at once. Anyone else is
 * invited, if the caller may invite people (the session's
 * `canInvitePeople`; 403 `forbidden` otherwise), and becomes a member with
 * this role when they first arrive. The server decides whether the address
 * is one it accepts (400 `invalid_request` otherwise) and stores it in its
 * one spelling. Someone who is already in the group, or already invited to
 * it, answers 409 `conflict`.
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
 * PATCH /api/spaces/:spaceId/members/:userId. Owners of a group only.
 * Taking "owner" away from the last owner of a space answers 409
 * `conflict`. An owner can use every app of the space; the exceptions made
 * for someone as a member stay, and apply again if they stop being an
 * owner. Answers 204 with no body.
 *
 * DELETE on the same address (an owner, or the member themselves, which is
 * leaving the group) has no body and answers 204. The last owner cannot be
 * removed or leave (409 `conflict`), and nobody leaves their personal space.
 */
export const memberPatchSchema = z
  .strictObject({ role: spaceRoleSchema, canAddApps: z.boolean() })
  .partial();
export type MemberPatch = z.infer<typeof memberPatchSchema>;

/**
 * DELETE /api/spaces/:spaceId/invitations: take back the invitation of
 * someone who has not arrived yet. Owners of the group only. Answers 204
 * with no body, and 404 when the group has no invitation for the address.
 * When it was the address's last invitation to a group, the person is no
 * longer let onto the server either.
 */
export const withdrawInvitationRequestSchema = z.strictObject({ email: z.string().trim().min(1).max(254) });
export type WithdrawInvitationRequest = z.infer<typeof withdrawInvitationRequestSchema>;

/**
 * PUT /api/spaces/:spaceId/apps/:appId: bring an app the space removed back
 * with its data. Owners, and members who may add apps; only an owner may
 * bring a removed app back. Answers 204 with no body. An app made in Hearth
 * is added to its space when it is made (POST
 * /api/spaces/:spaceId/catalog/:templateId, or the chat) and is that
 * space's alone: for any other space the answer is 404.
 *
 * An app that is already in the space is left as it is, and that is not an
 * error, unless `memberAccess` asks for something else than it has: that
 * answers 409 `conflict`, because access is changed through its own route.
 * 409 is also the answer for a member adding an app that the space has an
 * entry for which they cannot see.
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
 * app that was removed or that the server holds no app for; for one still
 * in use the answer is 409 `conflict`. `confirm` is the app's ID, typed by the person.
 * Answers 204 with no body.
 *
 * DELETE /api/spaces/:spaceId/apps/:appId, which removes the app and keeps
 * its data, has no body. Owners only.
 */
export const deleteAppDataRequestSchema = z.strictObject({ confirm: z.string() });
export type DeleteAppDataRequest = z.infer<typeof deleteAppDataRequestSchema>;

/**
 * POST /api/spaces/:spaceId/apps/:appId/move: move an app with its data to
 * another space. Answers 204 with no body.
 *
 * The caller must own the space the app is in (403 `forbidden` for a member
 * who can use it, 404 for anyone it is hidden from), and own the space it
 * goes to or be allowed to add apps there (403; 404 when they are not in
 * that space or it does not exist). The space must never have had the app:
 * one that has it, or had it and kept its data, answers 409 `conflict`.
 * Apps are not merged.
 *
 * The rows, the settings the space shares, and the own settings, switches
 * and pins of people who are in both spaces go with the app; those of
 * everyone else are deleted. Access starts afresh: exceptions made for
 * single members are gone, and a caller who is not an owner of the target
 * gets edit for themselves, as when they add an app.
 */
export const moveAppRequestSchema = z.strictObject({
  toSpaceId: z.string().min(1),
  /** What the members of the target get. Left out: "none", so a move never widens access by itself. */
  memberAccess: memberAccessSchema.optional(),
});
export type MoveAppRequest = z.infer<typeof moveAppRequestSchema>;

/**
 * PUT /api/spaces/:spaceId/apps/:appId/access. Owners only (403 `forbidden`
 * for a member who can use the app, 404 for anyone it is hidden from). What
 * is left out stays as it is, and the request is saved as a whole or not at
 * all. Answers 204 with no body.
 */
export const appAccessRequestSchema = z.strictObject({
  /** What every member gets who has no exception. */
  memberAccess: memberAccessSchema.optional(),
  /**
   * Exceptions by user ID. `null` removes one, so that the person follows
   * `memberAccess` again. Each must be someone in the space (400
   * `invalid_request` otherwise). An owner can use every app whatever their
   * exception says; it applies if they stop being an owner.
   */
  members: z.record(z.string(), memberAccessSchema.nullable()).optional(),
  /**
   * Whether an assistant may use the app here, within what the space allows
   * it (`Space.assistant`); false leaves the app out.
   */
  assistant: z.boolean().optional(),
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
 * apps that were removed and apps the server holds no app for, which is why
 * it has an ID but no name.
 */
export const installedAppSchema = z.object({
  id: z.string(),
  /**
   * False when the server holds no app of this ID: an install of one of the
   * apps that releases before the built-in apps held, which could not move
   * to its built-in app.
   */
  hasCode: z.boolean(),
  /** When the app was removed from the space, or null while it is there. Its data is kept either way. */
  removedAt: z.string().nullable(),
  /** How many rows of data the app holds in this space. */
  rowCount: z.number().int().nonnegative(),
  memberAccess: memberAccessSchema,
  /** Exceptions by user ID; a member not listed follows `memberAccess`. */
  members: z.record(z.string(), memberAccessSchema),
  /** False when the space's owners left the app out of what an assistant may use. */
  assistant: z.boolean(),
  /** The built-in app a made app was added from, when it was: the Add dialog brings a removed one back. */
  template: z.string().optional(),
});
export type InstalledApp = z.infer<typeof installedAppSchema>;

/**
 * GET /api/spaces/:spaceId/apps. Owners only (403 `forbidden` for a member,
 * 404 for anyone else). Apps in the order they were added, members in the
 * order they joined, invitations in the order they were made.
 */
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
 * space, `user` the caller's own. Anyone who can see the app may read both.
 * A value saved under a name the manifest no longer declares is left out,
 * and one that no longer fits its setting is given as the default.
 */
export const appSettingsSchema = z.object({
  space: settingValuesSchema,
  user: settingValuesSchema,
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * PATCH /api/spaces/:spaceId/apps/:appId/settings. Only the settings named
 * are changed, all of them or none. Naming a setting under `space` needs
 * edit access (403 `forbidden` without); `user` needs only view, and saves
 * for the caller alone. The server checks names and values against the
 * app's manifest: a name the manifest does not declare under that scope, or
 * a value that does not fit its setting, answers 400 `invalid_request`.
 */
export const appSettingsPatchSchema = z
  .strictObject({ space: settingValuesSchema, user: settingValuesSchema })
  .partial();
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

// ---------------------------------------------------------------------------
// Each person's own model, and the chat with it (docs/platform.md)
// ---------------------------------------------------------------------------

/**
 * How Hearth talks to a model: "openai" for any service that answers like
 * OpenAI's chat completions (DeepSeek, OpenAI, Kimi, Qwen, OpenRouter and
 * others), "anthropic" for Claude through Anthropic's own API.
 */
export const MODEL_PROTOCOLS = ["openai", "anthropic"] as const;
export const modelProtocolSchema = z.enum(MODEL_PROTOCOLS);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

/** GET /api/me/model: what the person saved, without the key, or null. */
export const modelSettingsSchema = z.object({
  protocol: modelProtocolSchema,
  baseUrl: z.string(),
  model: z.string(),
  /** Whether a key is saved. The key itself never leaves the server. */
  hasKey: z.boolean(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

/**
 * PUT /api/me/model. Without `apiKey`, the key saved before is kept, so
 * that changing the model does not ask for the key again.
 */
export const modelSettingsRequestSchema = z.strictObject({
  protocol: modelProtocolSchema,
  baseUrl: z.string().trim().min(1).max(300),
  model: z.string().trim().min(1).max(100),
  apiKey: z.string().trim().min(1).max(1000).optional(),
});
export type ModelSettingsRequest = z.infer<typeof modelSettingsRequestSchema>;

/** One message of the conversation as the browser keeps it: plain text. */
export const chatMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20_000),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** POST /api/chat: the conversation so far, last of all the person's new message. */
export const chatRequestSchema = z.strictObject({
  spaceId: z.string().min(1).max(100),
  messages: z.array(chatMessageSchema).min(1).max(60),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** What the model did in an app, for the conversation to show. */
export const CHAT_ACTIONS = ["app_created", "app_updated", "app_restored", "row_added", "row_updated"] as const;

/** What happened when the chat ended without an answer. */
export const CHAT_FAILURES = [
  "no_model",
  "no_key",
  "no_secret",
  "model_refused_key",
  "model_failed",
  "model_declined",
  "too_many_steps",
  "assistant_off",
] as const;
export type ChatFailure = (typeof CHAT_FAILURES)[number];

/**
 * One event of POST /api/chat's answer, a stream of server-sent events whose
 * data is this JSON. "text" is what the model said in one step; "action" a
 * change it made; the stream ends with "done" or "error".
 */
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("action"),
    action: z.enum(CHAT_ACTIONS),
    appId: z.string(),
    appName: z.string(),
    /** For a change to the app itself: the version it made, and the one before, which undoing it brings back. */
    version: z.number().int().positive().optional(),
    previous: z.number().int().positive().optional(),
    /** For "app_restored": the earlier version it brought back. */
    restored: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("error"), failure: z.enum(CHAT_FAILURES), detail: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("ping") }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;

/** A row of an app made in Hearth, as its sandboxed page and the chat see it. */
export type MadeRow = Record<string, unknown> & {
  id: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

/** POST and PATCH of a made app's row: the fields to store. */
export const madeRowWriteSchema = z.strictObject({ data: z.record(z.string(), z.unknown()) });

/** POST /api/spaces/:spaceId/apps/:appId/versions/:version/restore: a made app back at an earlier version, as a new one. */
export const madeRestoreSchema = z.object({
  version: z.number().int().positive(),
  previous: z.number().int().positive(),
  restored: z.number().int().positive(),
});
export type MadeRestore = z.infer<typeof madeRestoreSchema>;

/** GET /api/catalog: the apps shipped with Hearth, which anyone who may add apps adds as a made app of their own. */
export const catalogAppSchema = z.object({
  id: z.string(),
  name: z.object({ en: z.string(), zh: z.string() }),
  description: z.object({ en: z.string(), zh: z.string() }),
  icon: z.string(),
  color: z.string(),
  /** The hosts its page fetches from, through the server. */
  network: z.array(z.string()),
});
export type CatalogApp = z.infer<typeof catalogAppSchema>;

/** POST /api/spaces/:spaceId/catalog/:templateId: what the other members of a group get, as when adding any app. */
export const addFromCatalogRequestSchema = z.strictObject({ memberAccess: memberAccessSchema.optional() });
export type AddFromCatalogRequest = z.infer<typeof addFromCatalogRequestSchema>;

