/**
 * The chat's history (docs/platform.md, "The chat"): the tables `chats` and
 * `chat_entries`, each person's own conversations with their model, per
 * space. Only the person ever reads them, in a group too: every statement
 * here names the space and the person, and a conversation of someone else,
 * or of another space, is as absent as one that never was.
 *
 * A conversation goes when its person deletes it, and when they leave the
 * space or are removed from it (the database cascades from space_members).
 */
import { chatEntrySchema, type ChatEntry, type ChatMessage, type ChatSummary } from "@hearth/shared";
import type { Db } from "../db/database";
import { newId } from "../db/ids";
import { Refusal } from "../http/errors";

/** How many conversations one person keeps in one space at most. */
export const MAX_CHATS = 500;

/** How many entries a conversation holds before it takes no more messages. A turn that starts below it may end above it. */
export const MAX_ENTRIES = 500;

/** How many characters of what was said before the model is given at most, the newest first. */
export const HISTORY_BUDGET = 40_000;

/** How long a title is at most, before its ellipsis. */
const TITLE_LENGTH = 80;

/** Whose conversations: one person's, in one space. */
export type ChatScope = { spaceId: string; userId: string };

type SummaryRow = ChatSummary;
type EntryRow = { kind: ChatEntry["kind"]; data: string };

const SUMMARY = "id, title, created_at AS createdAt, updated_at AS updatedAt";

/** A conversation's title: the start of its first message, on one line. */
export function titleOf(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  // By code points, so that a character outside the basic plane is never cut in two.
  const characters = Array.from(flat);
  return characters.length <= TITLE_LENGTH ? flat : `${characters.slice(0, TITLE_LENGTH).join("").trimEnd()}…`;
}

/** One conversation of the person's in the space, without its entries, or null when they have none of that ID there. */
export function findChat(db: Db, request: ChatScope & { chatId: string }): ChatSummary | null {
  const row = db
    .prepare(`SELECT ${SUMMARY} FROM chats WHERE id = ? AND space_id = ? AND user_id = ?`)
    .get(request.chatId, request.spaceId, request.userId) as SummaryRow | undefined;
  return row ?? null;
}

/**
 * Starts a conversation for the person in the space. The caller has checked
 * that they are in it. Refuses with 409 when they keep MAX_CHATS there.
 */
export function createChat(db: Db, request: ChatScope & { title: string; now: string }): ChatSummary {
  const { spaceId, userId, title, now } = request;
  return db.transaction(() => {
    const { n } = db
      .prepare("SELECT count(*) AS n FROM chats WHERE space_id = ? AND user_id = ?")
      .get(spaceId, userId) as { n: number };
    if (n >= MAX_CHATS) {
      throw new Refusal(409, "conflict", `You have ${MAX_CHATS} conversations here. Delete some to start a new one.`);
    }
    const id = newId();
    db.prepare(
      `INSERT INTO chats (id, space_id, user_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, spaceId, userId, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }).immediate();
}

/** The person's conversations in the space, the one used last first. */
export function listChats(db: Db, scope: ChatScope): ChatSummary[] {
  return db
    .prepare(
      `SELECT ${SUMMARY} FROM chats
        WHERE space_id = ? AND user_id = ?
        ORDER BY updated_at DESC, id`,
    )
    .all(scope.spaceId, scope.userId) as SummaryRow[];
}

/** One conversation of the person's in the space, whole, or null when they have none of that ID there. */
export function readChat(db: Db, request: ChatScope & { chatId: string }): { chat: ChatSummary; entries: ChatEntry[] } | null {
  return db.transaction(() => {
    const chat = findChat(db, request);
    if (!chat) return null;
    const rows = db
      .prepare(
        `SELECT kind, data FROM chat_entries
          WHERE chat_id = ? AND space_id = ? AND user_id = ?
          ORDER BY seq`,
      )
      .all(request.chatId, request.spaceId, request.userId) as EntryRow[];
    // Written here from the same schema: one that no longer reads is a fault, logged and answered with 500.
    const entries = rows.map((row) => chatEntrySchema.parse({ ...(JSON.parse(row.data) as object), kind: row.kind }));
    return { chat, entries };
  })();
}

/** Deletes one conversation of the person's, with its entries. False when they have none of that ID there. */
export function deleteChat(db: Db, request: ChatScope & { chatId: string }): boolean {
  const { changes } = db
    .prepare("DELETE FROM chats WHERE id = ? AND space_id = ? AND user_id = ?")
    .run(request.chatId, request.spaceId, request.userId);
  return changes > 0;
}

/** How many entries one conversation of the person's holds; 0 for one they do not have. */
export function countEntries(db: Db, request: ChatScope & { chatId: string }): number {
  const { n } = db
    .prepare("SELECT count(*) AS n FROM chat_entries WHERE chat_id = ? AND space_id = ? AND user_id = ?")
    .get(request.chatId, request.spaceId, request.userId) as { n: number };
  return n;
}

/**
 * Adds an entry at the end of a conversation of the person's, and marks the
 * conversation used now. False when it is gone, deleted while it answered.
 */
export function appendEntry(db: Db, request: ChatScope & { chatId: string; entry: ChatEntry; now: string }): boolean {
  const { spaceId, userId, chatId, entry, now } = request;
  const { kind, ...data } = chatEntrySchema.parse(entry);
  return db.transaction(() => {
    const touched = db
      .prepare("UPDATE chats SET updated_at = ? WHERE id = ? AND space_id = ? AND user_id = ?")
      .run(now, chatId, spaceId, userId);
    if (touched.changes === 0) return false;
    db.prepare(
      `INSERT INTO chat_entries (chat_id, seq, space_id, user_id, kind, data, created_at)
       VALUES (@chatId,
               (SELECT coalesce(max(seq), 0) + 1 FROM chat_entries
                 WHERE chat_id = @chatId AND space_id = @spaceId AND user_id = @userId),
               @spaceId, @userId, @kind, @data, @now)`,
    ).run({ chatId, spaceId, userId, kind, data: JSON.stringify(data), now });
    return true;
  }).immediate();
}

/**
 * What the model is given of a conversation: what the person and the model
 * said, as plain text, without the changes it made or why a turn failed.
 * The newest texts within HISTORY_BUDGET characters, starting with something
 * the person said, and texts of the same side in a row joined into one
 * message with a blank line between, since a model takes turns that
 * alternate (the model speaks in several steps of one turn, and a turn
 * that failed leaves two of the person's messages in a row).
 */
export function historyFor(entries: readonly ChatEntry[]): ChatMessage[] {
  const texts: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") texts.push({ role: "user", content: entry.text });
    else if (entry.kind === "model") texts.push({ role: "assistant", content: entry.text });
  }
  // Within the budget, counted text by text, so that the newest message always fits on its own.
  let size = 0;
  let from = texts.length;
  while (from > 0 && size + texts[from - 1]!.content.length <= HISTORY_BUDGET) size += texts[--from]!.content.length;
  while (from < texts.length && texts[from]!.role !== "user") from++;
  const messages: ChatMessage[] = [];
  for (const text of texts.slice(from)) {
    const last = messages.at(-1);
    if (last?.role === text.role) last.content = `${last.content}\n\n${text.content}`;
    else messages.push({ ...text });
  }
  return messages;
}
