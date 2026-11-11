/**
 * Mini-apps' data and settings: the tables `app_rows` and `app_settings`.
 *
 * This is the only file with SQL for those two tables, so that there is one
 * place to check that every statement names its space and its app. So far it
 * holds one thing, deleting everything an app has in a space; reading and
 * writing rows and settings are added here, and nowhere else.
 *
 * Design: docs/mini-app-contract.md, section A6.
 */
import type { Db } from "../db/database";

/**
 * Deletes every row and every setting one app has in one space, and says how
 * many of each went. The caller holds the transaction, has checked that the
 * person may do this, and deletes the app's entry in the space afterwards.
 */
export function deleteAllData(
  db: Db,
  spaceId: string,
  appId: string,
): { rows: number; settings: number } {
  const rows = db
    .prepare("DELETE FROM app_rows WHERE space_id = ? AND app_id = ?")
    .run(spaceId, appId).changes;
  const settings = db
    .prepare("DELETE FROM app_settings WHERE space_id = ? AND app_id = ?")
    .run(spaceId, appId).changes;
  return { rows, settings };
}
