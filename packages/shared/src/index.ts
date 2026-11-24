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
  /**
   * How many people are invited to the group and have not arrived yet. Only
   * for a group's owners, who see who they are; left out for a member and
   * for a personal space.
   */
  pendingInvitations: z.number().int().nonnegative().optional(),
});
export type Space = z.infer<typeof spaceSchema>;

/**
 * Where a copy of a published app came from (docs/center.md). `listingId`
 * is the published app's ID, missing once it is unpublished. `by` is its
 * publisher's name, sent only to a viewer who is a member of the group it
 * is published to, with `mine` when that viewer is its publisher.
 * `untouched` is sent while nobody has changed the copy, which is then not
 * moved into a group. Where an app is published is not here: the publish
 * dialog reads it from GET .../publish.
 */
export const appSourceSchema = z.object({
  listingId: z.string().optional(),
  by: z.string().optional(),
  mine: z.boolean().optional(),
  untouched: z.boolean().optional(),
});
export type AppSource = z.infer<typeof appSourceSchema>;

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
  /** For a copy of a published app (docs/center.md): where it came from. */
  source: appSourceSchema.optional(),
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
  /**
   * Leaving a group whose only member is the person leaving deletes the
   * group, and the request did not carry its name to confirm that.
   */
  "confirm_required",
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
 * leaving the group) answers 204 with no body; see `leaveGroupRequestSchema`
 * for its body.
 */
export const memberPatchSchema = z
  .strictObject({ role: spaceRoleSchema, canAddApps: z.boolean() })
  .partial();
export type MemberPatch = z.infer<typeof memberPatchSchema>;

/**
 * DELETE /api/spaces/:spaceId/members/:userId: remove a member, or leave
 * (the address names the person asking). The body may be left out.
 *
 * - The last owner cannot be removed, nor leave while anyone else is in the
 *   group (409 `conflict`): someone else must be made an owner first.
 * - Nobody leaves their personal space (409 `conflict`).
 * - When the person leaving is the group's only member, leaving deletes the
 *   group for good, with everything in it: its apps with their rows,
 *   settings and versions, everyone's conversations there, and its pending
 *   invitations (an address whose last invitation that was is no longer let
 *   onto the server). `confirm` must then be the group's name as the
 *   session gives it; spaces around either do not count. Without it, or
 *   with another text, the answer is 409 `confirm_required` and nothing
 *   changes.
 * - Someone leaving who sends a `confirm` that is not empty, while anyone
 *   else is in the group, is refused (409 `conflict`) and nothing changes:
 *   they were told leaving deletes the group, and someone has joined since.
 *   Removing someone else ignores `confirm`.
 */
export const leaveGroupRequestSchema = z.strictObject({ confirm: z.string().max(200).optional() });
export type LeaveGroupRequest = z.infer<typeof leaveGroupRequestSchema>;

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
 * DELETE /api/spaces/:spaceId/apps/:appId/data: delete an app from a space
 * for good, with everything it has there: its rows, settings, versions,
 * everyone's access, switches and pins, and its entry; the chat's requests
 * to delete its rows that still wait for an answer expire. It cannot be
 * undone. Owners only (403 `forbidden` for a member, 404 for anyone not in
 * the space or a space that never had the app). Answers 204 with no body.
 *
 * For an app the server holds (every app made in Hearth), `confirm` is the
 * app's name as the person typed it, in either of its languages; spaces
 * around it do not count. The app may be in use or removed. For an install
 * the server holds no app for, `confirm` is its ID. Anything else answers
 * 400 `invalid_request`: a second guard besides the dialog.
 *
 * DELETE /api/spaces/:spaceId/apps/:appId, which removes the app and keeps
 * its data, has no body. Owners only.
 */
export const deleteAppDataRequestSchema = z.strictObject({ confirm: z.string().max(200) });
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
  /**
   * For an app the server holds, removed or not, its name in both languages
   * (a name in its maker's words is the same in both), its icon and its
   * colour, so that the Apps page can draw a removed app, which the session
   * no longer lists. Left out when the server holds no app of this ID.
   */
  name: z.object({ en: z.string(), zh: z.string() }).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
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

/**
 * One message of the conversation as the model is given it: plain text.
 * The server builds these from the conversation it keeps (`historyFor` in
 * packages/server/src/model/chats.ts).
 */
export const chatMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * POST /api/chat: the person's new message, in a conversation of theirs in
 * the space, or in a new one when `chatId` is left out. The server keeps the
 * conversation and gives the model what was said before.
 */
export const chatRequestSchema = z.strictObject({
  spaceId: z.string().min(1).max(100),
  chatId: z.string().min(1).max(100).optional(),
  message: z.string().trim().min(1).max(20_000),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * What the model did in an app, for the conversation to show.
 * "delete_requested" is the one thing it asks for rather than does: rows it
 * would delete, which go only when the person confirms (owner's decision 7).
 */
export const CHAT_ACTIONS = ["app_created", "app_updated", "app_restored", "row_added", "row_updated", "delete_requested"] as const;

/** The most rows the model may ask to delete at once. */
export const MAX_DELETE_ROWS = 50;

/** How many of the rows asked about a request to delete shows, each in a few words. */
export const DELETE_PREVIEW_ROWS = 5;

/** How long a request to delete waits for the person: older, it expires when someone acts on it. */
export const CONFIRMATION_HOURS = 24;

/**
 * Where a request of the model's to delete rows stands: waiting for the
 * person, confirmed (the rows went), declined (nothing went), or expired
 * (nothing went: it waited too long, or its app was deleted or moved).
 */
export const CONFIRMATION_STATUSES = ["pending", "confirmed", "declined", "expired"] as const;
export const confirmationStatusSchema = z.enum(CONFIRMATION_STATUSES);
export type ConfirmationStatus = z.infer<typeof confirmationStatusSchema>;

/**
 * POST /api/spaces/:spaceId/chats/:chatId/confirmations/:confirmationId: the
 * person's answer to a request of the model's to delete rows. Only the person
 * whose conversation it is (404 for anyone else, as for the conversation).
 * 409 `conflict` when it was answered already.
 *
 * "confirm" checks again, at that moment, everything the request needed:
 * that the space lets the assistant change things and that the person, and
 * the assistant for them, may change the app (403 `forbidden` otherwise),
 * and deletes the rows that are still there (those gone since are skipped).
 * "decline" deletes nothing. A refusal leaves the request waiting. A request
 * older than CONFIRMATION_HOURS, or whose app is no longer in the space,
 * expires instead, whatever the answer: that is recorded, and answered
 * with status "expired".
 */
export const confirmationDecisionSchema = z.strictObject({ decision: z.enum(["confirm", "decline"]) });
export type ConfirmationDecision = z.infer<typeof confirmationDecisionSchema>;

/** The answer to a decision: where the request stands now, and how many rows went. */
export const confirmationResultSchema = z.object({
  status: confirmationStatusSchema,
  deleted: z.number().int().nonnegative(),
});
export type ConfirmationResult = z.infer<typeof confirmationResultSchema>;

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

/** A conversation as its list shows it. Its title is the start of its first message. */
export const chatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  /** When something was last said in it. */
  updatedAt: z.string(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

/** GET /api/spaces/:spaceId/chats: the person's own conversations there, the one used last first. */
export const chatListSchema = z.object({ chats: z.array(chatSummarySchema) });
export type ChatList = z.infer<typeof chatListSchema>;

/** What a change the model made in an app says, as an event and as a kept entry. */
const chatActionFields = {
  action: z.enum(CHAT_ACTIONS),
  appId: z.string(),
  appName: z.string(),
  /** For a change to the app itself: the version it made, and the one before, which undoing it brings back. */
  version: z.number().int().positive().optional(),
  previous: z.number().int().positive().optional(),
  /** For "app_restored": the earlier version it brought back. */
  restored: z.number().int().positive().optional(),
  /**
   * For "delete_requested": the request (its ID, for the person's answer),
   * the collection, how many rows it names and a few words of each of the
   * first DELETE_PREVIEW_ROWS of them, as the person sees them before
   * deciding. The preview is the rows' content: data, never translated.
   */
  confirmationId: z.string().optional(),
  collection: z.string().optional(),
  count: z.number().int().positive().optional(),
  preview: z.array(z.string()).optional(),
  /**
   * For "delete_requested", where the request stands now and how many rows
   * went. Not kept with the entry: the server reads both afresh whenever it
   * gives the conversation, so the card shows its present state, on every
   * device. The event says "pending".
   */
  status: confirmationStatusSchema.optional(),
  deleted: z.number().int().nonnegative().optional(),
};

/**
 * One entry of a kept conversation, in the order it happened: what the
 * person said, what the model said in one step, a change it made, or why a
 * turn ended without an answer.
 */
export const chatEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string() }),
  z.object({ kind: z.literal("model"), text: z.string() }),
  z.object({ kind: z.literal("action"), ...chatActionFields }),
  z.object({ kind: z.literal("failure"), failure: z.enum(CHAT_FAILURES), detail: z.string() }),
]);
export type ChatEntry = z.infer<typeof chatEntrySchema>;

/** GET /api/spaces/:spaceId/chats/:chatId: one conversation of the person's, whole. */
export const chatSchema = z.object({ chat: chatSummarySchema, entries: z.array(chatEntrySchema) });
export type Chat = z.infer<typeof chatSchema>;

/**
 * One event of POST /api/chat's answer, a stream of server-sent events whose
 * data is this JSON. "chat" comes first when the message started a new
 * conversation; "text" is what the model said in one step; "action" a
 * change it made; the stream ends with "done" or "error". "text", "action"
 * and "error" are kept with the conversation as they are sent.
 */
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat"), chatId: z.string(), title: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("action"), ...chatActionFields }),
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


// ---------------------------------------------------------------------------
// The app center (docs/center.md): apps published to a group, and copies of them
// ---------------------------------------------------------------------------

/** How long the note of a publish ("what changed") is at most. */
export const MAX_PUBLISH_NOTE = 200;

/** How many apps one person may have published to one group at once. */
export const MAX_LISTINGS_PER_GROUP = 50;

/** How many published apps GET /api/center gives at most, the newest first. */
export const MAX_CENTER_LISTINGS = 500;

/** A collection of a published app, as the center and the publish dialog show it: its name and its fields' names. */
export const listingCollectionSchema = z.object({ name: z.string(), fields: z.array(z.string()) });
export type ListingCollection = z.infer<typeof listingCollectionSchema>;

/**
 * GET /api/center: one app published to a group the person is in. Its name
 * and description are its maker's words, never translated, in both fields
 * alike, or a built-in app's in both languages. `publishedBy` names the
 * publisher, whom the person shares that group with; no email address is
 * ever sent. `mine` is true for the person's own; `canUnpublish` for those
 * and, for an owner of the group, every one there.
 */
export const centerListingSchema = z.object({
  id: z.string(),
  /** The group it is published to. */
  spaceId: z.string(),
  name: z.object({ en: z.string(), zh: z.string() }),
  description: z.object({ en: z.string(), zh: z.string() }),
  icon: z.string(),
  color: z.string(),
  collections: z.array(listingCollectionSchema),
  publishedBy: z.object({ id: z.string(), name: z.string() }),
  /** 1 when first published, one more each time it is published again. */
  revision: z.number().int().positive(),
  /** What changed, in the publisher's words; "" for nothing said. */
  note: z.string(),
  updatedAt: z.string(),
  mine: z.boolean(),
  canUnpublish: z.boolean(),
});
export type CenterListing = z.infer<typeof centerListingSchema>;

/**
 * GET /api/center: the published apps of every group the person is in,
 * newest first, at most MAX_CENTER_LISTINGS. Which of the person's spaces
 * hold a copy already the web app reads from the session
 * (`AppSummary.source.listingId`), not from here.
 */
export const centerSchema = z.object({ listings: z.array(centerListingSchema) });
export type Center = z.infer<typeof centerSchema>;

/**
 * Why an app cannot be published, as a code the publish dialog words in
 * the person's language:
 * - "invalid": its manifest or page no longer passes the checks (`detail`
 *   says what, in the checker's English, as the chat shows it);
 * - "network": it names hosts, which no published app may;
 * - "unchanged_copy": it is a copy nobody changed, of a built-in app or of
 *   a published one: someone else's app as they shipped or shared it;
 * - "email": the email address of the publisher, or of someone they share
 *   a space with, is in it (`where` says where, never whose);
 * - "too_many": the person has MAX_LISTINGS_PER_GROUP apps published to
 *   that group (`spaceId`) already.
 */
export const PUBLISH_PROBLEM_CODES = ["invalid", "network", "unchanged_copy", "email", "too_many"] as const;
export const publishProblemCodeSchema = z.enum(PUBLISH_PROBLEM_CODES);
export type PublishProblemCode = z.infer<typeof publishProblemCodeSchema>;

/** The part of a published app a problem was found in. `line` counts the page's lines from 1. */
export const PUBLISH_PARTS = ["name", "description", "instructions", "collections", "settings", "page"] as const;
export const publishPlaceSchema = z.object({
  part: z.enum(PUBLISH_PARTS),
  line: z.number().int().positive().optional(),
});
export type PublishPlace = z.infer<typeof publishPlaceSchema>;

export const publishProblemSchema = z.object({
  code: publishProblemCodeSchema,
  /** For "email". */
  where: publishPlaceSchema.optional(),
  /** For "invalid". */
  detail: z.string().optional(),
  /** For "too_many": the group. */
  spaceId: z.string().optional(),
});
export type PublishProblem = z.infer<typeof publishProblemSchema>;

/** One place an app is published to, as its publish dialog lists it. */
export const appListingSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  revision: z.number().int().positive(),
  note: z.string(),
  updatedAt: z.string(),
  canUnpublish: z.boolean(),
});
export type AppListing = z.infer<typeof appListingSchema>;

/**
 * GET /api/spaces/:spaceId/apps/:appId/publish, for those who may publish
 * the app, an owner of its space (404 for an app the person cannot see, as
 * for one that does not exist; 403 for one they see but may not publish): exactly
 * what would leave (`app`: its settings as declared, with their defaults;
 * its instructions in full; the size of its page in bytes), the groups it
 * may go to, the groups the person is in where it is published already,
 * and every problem that would refuse it. What never leaves (rows, setting
 * values, conversations, versions) is not here at all.
 */
export const publishReviewSchema = z.object({
  app: z.object({
    name: z.object({ en: z.string(), zh: z.string() }),
    description: z.object({ en: z.string(), zh: z.string() }),
    icon: z.string(),
    color: z.string(),
    collections: z.array(listingCollectionSchema),
    settings: z.record(z.string(), z.unknown()),
    instructions: z.string(),
    pageBytes: z.number().int().nonnegative(),
  }),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  listings: z.array(appListingSchema),
  problems: z.array(publishProblemSchema),
});
export type PublishReview = z.infer<typeof publishReviewSchema>;

/**
 * POST /api/spaces/:spaceId/apps/:appId/publish: publish the app to a group
 * the person is in, or publish it there again, which replaces what was
 * published and adds 1 to the revision: 201 when it was not published
 * there yet, 200 when it was. A problem refuses it, 400
 * `invalid_request` (409 `conflict` for "too_many"), with an English
 * message: the dialog words the problems from GET .../publish instead.
 */
export const publishRequestSchema = z.strictObject({
  /** The group. */
  to: z.string().min(1),
  /** What changed, in the publisher's words. */
  note: z.string().trim().max(MAX_PUBLISH_NOTE).optional(),
});
export type PublishRequest = z.infer<typeof publishRequestSchema>;

export const publishResultSchema = z.object({ id: z.string(), revision: z.number().int().positive() });
export type PublishResult = z.infer<typeof publishResultSchema>;

/**
 * POST /api/spaces/:spaceId/center/:id: add a copy of a published app to the
 * group it is published to or to the person's personal space (404 for any
 * other, and for a published app outside the person's groups), for someone
 * who may add apps there. A space that holds a copy of it already answers
 * 409 `conflict`; one whose copy was removed gets it back, with its data
 * (`restored`). `memberAccess` as when adding any app: "none" when left out.
 */
export const addCopyRequestSchema = z.strictObject({ memberAccess: memberAccessSchema.optional() });
export type AddCopyRequest = z.infer<typeof addCopyRequestSchema>;

export const addCopyResultSchema = z.object({ appId: z.string(), restored: z.boolean() });
export type AddCopyResult = z.infer<typeof addCopyResultSchema>;
