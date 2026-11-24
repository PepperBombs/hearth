/**
 * What the model asks before it deletes (docs/platform.md, owner's decision
 * 7): the table `chat_confirmations`, one row for each request of the
 * model's to delete rows of an app, in a conversation of a person's, and
 * where it stands. This is the only file with SQL for it.
 *
 * A request belongs to its conversation, and so to one person in one space:
 * every statement that reads or answers one names the conversation, the
 * space and the person, and another person's request, or one of another
 * conversation or space, is as absent as one that never was. The one
 * statement that names no person is `expireRequestsFor`, which an owner's
 * deleting or moving an app runs for everyone's requests about that app in
 * the space, since none of them can be carried out any more.
 *
 * What the rows are, and who may delete them, is decided elsewhere
 * (src/model/chat.ts, through src/made/apps.ts): this file only keeps what
 * was asked and what became of it.
 */
import { CONFIRMATION_HOURS, type ConfirmationStatus } from "@hearth/shared";
import type { Db } from "../db/database";
import { newId } from "../db/ids";

/** How long a request waits, in milliseconds. */
export const CONFIRMATION_MS = CONFIRMATION_HOURS * 60 * 60 * 1000;

/** Whose conversation, and which. */
export type ConversationScope = { chatId: string; spaceId: string; userId: string };

/** A request as it is kept. */
export type DeleteRequest = {
  id: string;
  appId: string;
  collection: string;
  rowIds: string[];
  status: ConfirmationStatus;
  /** How many rows went, once confirmed; null before, and for any other end. */
  deleted: number | null;
  createdAt: string;
  decidedAt: string | null;
};

type StoredRequest = Omit<DeleteRequest, "rowIds"> & { rowIds: string };

const COLUMNS = `id, app_id AS appId, collection, row_ids AS rowIds, status, deleted,
                 created_at AS createdAt, decided_at AS decidedAt`;

function parsed(row: StoredRequest): DeleteRequest {
  return { ...row, rowIds: JSON.parse(row.rowIds) as string[] };
}

/**
 * Keeps a new request, waiting for the person, in a conversation of theirs.
 * Null when the conversation is gone (deleted while it answered), in which
 * case nothing is kept.
 */
export function createDeleteRequest(
  db: Db,
  request: ConversationScope & { appId: string; collection: string; rowIds: readonly string[]; now: string },
): string | null {
  const id = newId();
  // Written only beside a conversation of this person's in this space: the database checks the
  // same (its key to chats), and this says "gone" instead of failing.
  const { changes } = db
    .prepare(
      `INSERT INTO chat_confirmations (id, chat_id, space_id, user_id, app_id, collection, row_ids, status, created_at)
       SELECT @id, id, space_id, user_id, @appId, @collection, @rowIds, 'pending', @now
         FROM chats
        WHERE id = @chatId AND space_id = @spaceId AND user_id = @userId`,
    )
    .run({
      id,
      chatId: request.chatId,
      spaceId: request.spaceId,
      userId: request.userId,
      appId: request.appId,
      collection: request.collection,
      rowIds: JSON.stringify(request.rowIds),
      now: request.now,
    });
  return changes === 0 ? null : id;
}

/** One request in a conversation of the person's, or null when they have none of that ID there. */
export function findDeleteRequest(db: Db, request: ConversationScope & { id: string }): DeleteRequest | null {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM chat_confirmations
        WHERE id = ? AND chat_id = ? AND space_id = ? AND user_id = ?`,
    )
    .get(request.id, request.chatId, request.spaceId, request.userId) as StoredRequest | undefined;
  return row ? parsed(row) : null;
}

/** Every request of a conversation of the person's, by ID. */
export function deleteRequestsOf(db: Db, scope: ConversationScope): Map<string, DeleteRequest> {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM chat_confirmations
        WHERE chat_id = ? AND space_id = ? AND user_id = ?`,
    )
    .all(scope.chatId, scope.spaceId, scope.userId) as StoredRequest[];
  return new Map(rows.map((row) => [row.id, parsed(row)]));
}

/**
 * Records the end of a request that is still waiting: confirmed with how
 * many rows went, declined, or expired. False when it was not waiting (or
 * is not the person's), and then nothing changes.
 */
export function settleDeleteRequest(
  db: Db,
  request: ConversationScope & { id: string; status: Exclude<ConfirmationStatus, "pending">; deleted: number | null; at: string },
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE chat_confirmations
          SET status = @status, deleted = @deleted, decided_at = @at
        WHERE id = @id AND chat_id = @chatId AND space_id = @spaceId AND user_id = @userId AND status = 'pending'`,
    )
    .run({
      id: request.id,
      chatId: request.chatId,
      spaceId: request.spaceId,
      userId: request.userId,
      status: request.status,
      deleted: request.deleted,
      at: request.at,
    });
  return changes > 0;
}

/**
 * Expires every request still waiting to delete rows of an app in a space,
 * whoever's they are: the app is being deleted, or moved out of the space,
 * so none of them can be carried out there any more. The caller holds the
 * transaction and has checked that the person may delete or move the app.
 */
export function expireRequestsFor(db: Db, request: { spaceId: string; appId: string; at: string }): number {
  return db
    .prepare(
      `UPDATE chat_confirmations
          SET status = 'expired', decided_at = @at
        WHERE space_id = @spaceId AND app_id = @appId AND status = 'pending'`,
    )
    .run(request).changes;
}

/**
 * Where a request stands as the person should see it now: one still waiting
 * after CONFIRMATION_MS has expired, at the moment its time ran out, though
 * that is written only when someone answers it.
 */
export function standing(request: DeleteRequest, now: Date): { status: ConfirmationStatus; deleted: number; decidedAt: string | null } {
  if (request.status === "pending") {
    const runsOut = Date.parse(request.createdAt) + CONFIRMATION_MS;
    if (now.getTime() > runsOut) return { status: "expired", deleted: 0, decidedAt: new Date(runsOut).toISOString() };
  }
  return { status: request.status, deleted: request.deleted ?? 0, decidedAt: request.decidedAt };
}
