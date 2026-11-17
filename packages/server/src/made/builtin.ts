/**
 * What the server does with the built-in apps when it starts
 * (docs/platform.md, "Built-in apps"): it brings their untouched copies up
 * to date (`updateBuiltInApps`), and moves the build's own apps of the same
 * name to them (`moveLegacyInstalls`).
 *
 * The move: every install of an app whose ID is a built-in app's (grocery,
 * ideas, trending)
 * becomes that built-in app, in place, its data, settings, access and
 * switches carried over (`adoptInstall`). Removed installs move too, so that
 * adding the app again brings their data back. Each install moves alone: one
 * that cannot, because a row does not fit, stays as it was and is reported,
 * and the others move all the same.
 */
import type { Registry } from "../apps/registry";
import { forgetJobs } from "../apps/jobs";
import type { Db } from "../db/database";
import { adoptInstall, updateFromTemplate } from "./apps";
import type { Template } from "./catalog";

export type Moved = { spaceId: string; from: string; to: string };
export type NotMoved = { spaceId: string; from: string; reason: string };

export function moveLegacyInstalls(db: Db, registry: Registry, catalog: readonly Template[]): { moved: Moved[]; failed: NotMoved[] } {
  const moved: Moved[] = [];
  const failed: NotMoved[] = [];
  for (const template of catalog) {
    const installs = db
      .prepare("SELECT space_id AS spaceId FROM space_apps WHERE app_id = ? ORDER BY created_at, space_id")
      .all(template.id) as { spaceId: string }[];
    for (const { spaceId } of installs) {
      try {
        const { appId } = db.transaction(() => {
          const adopted = adoptInstall(db, registry, {
            spaceId,
            appId: template.id,
            template: { id: template.id, hash: template.hash },
            manifest: template.manifest,
            html: template.html,
          });
          // Its job's status: the page refreshes what the job fetched.
          forgetJobs(db, spaceId, adopted.appId);
          return adopted;
        })();
        moved.push({ spaceId, from: template.id, to: appId });
      } catch (error) {
        failed.push({ spaceId, from: template.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { moved, failed };
}

export type Updated = { spaceId: string; appId: string; template: string; version: number };
export type NotUpdated = { spaceId: string; appId: string; template: string; reason: string };

/**
 * Brings every copy of a built-in app that nobody changed (its
 * `template_hash` is still one Hearth wrote) up to the built-in app as
 * Hearth ships it now, as a new version: so a fix to a built-in app reaches
 * every space that has it, as a change to the build's apps did. A copy that
 * a person or their model changed, or took back to an earlier version, is
 * theirs and stays as it is. One whose stored rows would not fit the new
 * fields stays as it is too, and is reported.
 */
export function updateBuiltInApps(db: Db, catalog: readonly Template[]): { updated: Updated[]; failed: NotUpdated[] } {
  const updated: Updated[] = [];
  const failed: NotUpdated[] = [];
  for (const template of catalog) {
    const copies = db
      .prepare(
        `SELECT app_id AS appId, space_id AS spaceId FROM made_apps
          WHERE template = ? AND template_hash IS NOT NULL AND template_hash <> ?
          ORDER BY created_at, app_id`,
      )
      .all(template.id, template.hash) as { appId: string; spaceId: string }[];
    for (const { appId, spaceId } of copies) {
      try {
        updated.push({ spaceId, appId, template: template.id, version: updateFromTemplate(db, appId, template) });
      } catch (error) {
        failed.push({ spaceId, appId, template: template.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { updated, failed };
}

