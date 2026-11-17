/**
 * The move of the build's own apps to the built-in apps made in Hearth
 * (docs/platform.md, "Built-in apps"). When the server starts, every
 * install of an app whose ID is a built-in app's (grocery, ideas, trending)
 * becomes that built-in app, in place, its data, settings, access and
 * switches carried over (`adoptInstall`). Removed installs move too, so that
 * adding the app again brings their data back. Each install moves alone: one
 * that cannot, because a row does not fit, stays as it was and is reported,
 * and the others move all the same.
 */
import type { Registry } from "../apps/registry";
import { forgetJobs } from "../apps/jobs";
import type { Db } from "../db/database";
import { adoptInstall } from "./apps";
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
          const adopted = adoptInstall(db, registry, { spaceId, appId: template.id, template: template.id, manifest: template.manifest, html: template.html });
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
