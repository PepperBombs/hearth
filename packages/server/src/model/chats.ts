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
import { deleteRequestsOf, standing } from "./confirmations";

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
type EntryRow = { kind: ChatEntry["kind"]; data: string; at: string };

/**
 * An entry with when it was kept, and for a request to delete, when it was
 * answered: what `historyFor` places the model's notes of the answers by.
 */
export type TimedEntry = ChatEntry & { at?: string; decidedAt?: string | null };

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

/**
 * One conversation of the person's in the space, whole, with when each entry
 * was kept, or null when they have none of that ID there. A request to
 * delete carries where it stands now (`standing` in confirmations.ts), read
 * from its own table, since it changes after the entry was kept.
 */
export function readTimedChat(
  db: Db,
  request: ChatScope & { chatId: string },
  now: Date = new Date(),
): { chat: ChatSummary; entries: (ChatEntry & { at: string; decidedAt?: string | null })[] } | null {
  return db.transaction(() => {
    const chat = findChat(db, request);
    if (!chat) return null;
    const rows = db
      .prepare(
        `SELECT kind, data, created_at AS at FROM chat_entries
          WHERE chat_id = ? AND space_id = ? AND user_id = ?
          ORDER BY seq`,
      )
      .all(request.chatId, request.spaceId, request.userId) as EntryRow[];
    const requests = deleteRequestsOf(db, request);
    const entries = rows.map((row) => {
      // Written here from the same schema: one that no longer reads is a fault, logged and answered with 500.
      const entry = chatEntrySchema.parse({ ...(JSON.parse(row.data) as object), kind: row.kind });
      if (entry.kind !== "action" || entry.action !== "delete_requested" || entry.confirmationId === undefined) {
        return { ...entry, at: row.at };
      }
      const kept = requests.get(entry.confirmationId);
      // Its row goes only with the conversation, so it is always there; were it not, nothing could be deleted by it.
      const state = kept ? standing(kept, now) : { status: "expired" as const, deleted: 0, decidedAt: null };
      return { ...entry, status: state.status, deleted: state.deleted, at: row.at, decidedAt: state.decidedAt };
    });
    return { chat, entries };
  })();
}

/** One conversation of the person's in the space, whole, as the page shows it, or null when they have none of that ID there. */
export function readChat(
  db: Db,
  request: ChatScope & { chatId: string },
  now: Date = new Date(),
): { chat: ChatSummary; entries: ChatEntry[] } | null {
  const timed = readTimedChat(db, request, now);
  if (!timed) return null;
  return { chat: timed.chat, entries: timed.entries.map(({ at: _at, decidedAt: _decidedAt, ...entry }) => entry as ChatEntry) };
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
 * What the model is told of the person's answer to a request of its own to
 * delete rows, as a note on the person's side: Hearth's words, not theirs.
 * Null while the request waits.
 */
export function answerNote(entry: ChatEntry): string | null {
  if (entry.kind !== "action" || entry.action !== "delete_requested") return null;
  const count = entry.count ?? 0;
  const what = `${count} ${count === 1 ? "entry" : "entries"} from ${JSON.stringify(entry.appName)} (collection ${JSON.stringify(entry.collection ?? "")})`;
  switch (entry.status) {
    case "confirmed": {
      const deleted = entry.deleted ?? 0;
      const gone = deleted < count ? `; ${deleted} deleted, the others were gone already` : "";
      return `[Hearth: the person confirmed deleting ${what}${gone}. Do not ask again.]`;
    }
    case "declined":
      return `[Hearth: the person declined deleting ${what}; nothing was deleted. Do not ask again unless they do.]`;
    case "expired":
      return `[Hearth: the request to delete ${what} expired unanswered, or its app is gone; nothing was deleted.]`;
    default:
      return null;
  }
}

/**
 * What the model is given of a conversation: what the person and the model
 * said, as plain text, without the changes it made or why a turn failed,
 * but with a note of each answer the person gave to a request of the
 * model's to delete rows (`answerNote`), on the person's side, before the
 * first message of theirs written after the answer (or, without times,
 * after the request), so that the model knows and does not ask again.
 * The newest texts within HISTORY_BUDGET characters, starting with something
 * the person said, and texts of the same side in a row joined into one
 * message with a blank line between, since a model takes turns that
 * alternate (the model speaks in several steps of one turn, and a turn
 * that failed leaves two of the person's messages in a row).
 */
export function historyFor(entries: readonly TimedEntry[]): ChatMessage[] {
  const texts: ChatMessage[] = [];
  /** Notes of answers not yet placed, each with when it was given. */
  let waiting: { note: string; decidedAt: string | null }[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      const at = entry.at;
      const due = waiting.filter((answer) => at === undefined || answer.decidedAt === null || answer.decidedAt <= at);
      waiting = waiting.filter((answer) => !due.includes(answer));
      for (const answer of due) texts.push({ role: "user", content: answer.note });
      texts.push({ role: "user", content: entry.text });
    } else if (entry.kind === "model") texts.push({ role: "assistant", content: entry.text });
    else {
      const note = answerNote(entry);
      if (note !== null) waiting.push({ note, decidedAt: entry.decidedAt ?? null });
    }
  }
  for (const answer of waiting) texts.push({ role: "user", content: answer.note });
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
