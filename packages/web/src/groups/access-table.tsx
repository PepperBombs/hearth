/**
 * The owners' table of who can use each app of a group: one row per app,
 * one column for what every member gets ("Everyone") and one for each
 * member who is not an owner, whose cell is an exception or "as everyone".
 * Owners have no column: they can always use every app.
 *
 * A choice is saved at once (PUT .../apps/:appId/access) and shown before
 * the server answers; whatever it answers, the owners' list is read again.
 * This only says what was decided. What a person may do is still worked out
 * on the server, by `resolveInstall`, from these same decisions.
 */
import type { AppAccessRequest, MemberAccess, Space, SpaceApps, SpaceMemberDetail } from "@hearth/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useBundledApps } from "../apps/bundled";
import { AppIcon } from "../components/app-icon";
import { LinkedText } from "../components/linked-text";
import { pickLocalized, type PlainMessageKey } from "../i18n";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";
import { setAppAccess } from "./api";
import { spaceAppsKey } from "./queries";

/** A native select in the kit's look: 44px tall with 16px text on phones. */
export const SELECT_CLASS =
  "h-9 max-w-full rounded-ctl border border-line bg-surface px-2 text-fg disabled:opacity-55 max-md:h-11 max-md:text-lg";

const LEVELS: readonly { value: MemberAccess; label: PlainMessageKey; asEveryone: PlainMessageKey }[] = [
  { value: "none", label: "groups.levelNone", asEveryone: "groups.levelAsEveryoneNone" },
  { value: "view", label: "groups.levelView", asEveryone: "groups.levelAsEveryoneView" },
  { value: "edit", label: "groups.levelEdit", asEveryone: "groups.levelAsEveryoneEdit" },
];

/** The value of a member's cell that means "no exception": they get what everyone gets. */
const AS_EVERYONE = "everyone";

type Change = { appId: string; body: AppAccessRequest };

/** The owners' list with a change applied, to show it before the server has answered. */
function applied(list: SpaceApps, { appId, body }: Change): SpaceApps {
  return {
    ...list,
    apps: list.apps.map((app) => {
      if (app.id !== appId) return app;
      const members = { ...app.members };
      for (const [memberId, level] of Object.entries(body.members ?? {})) {
        if (level === null) delete members[memberId];
        else members[memberId] = level;
      }
      return { ...app, memberAccess: body.memberAccess ?? app.memberAccess, members };
    }),
  };
}

/** The name and icon of an app as this browser knows it: from the session, else the build, else its ID. */
function useAppLabel(): (appId: string) => { name: string; icon: string; color: string } {
  const session = useSession();
  const bundled = useBundledApps();
  const { locale } = useI18n();
  return (appId) => {
    const listed = session.apps.find((app) => app.id === appId);
    if (listed) return { name: pickLocalized(listed.name, locale), icon: listed.icon, color: listed.color };
    const manifest = bundled.find((app) => app.id === appId)?.manifest;
    if (manifest) return { name: pickLocalized(manifest.name, locale), icon: manifest.icon, color: manifest.color };
    return { name: appId, icon: "box", color: "" };
  };
}

export function AccessTable({ space, list }: { space: Space; list: SpaceApps }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const headingId = useId();
  const label = useAppLabel();
  const key = spaceAppsKey(space.id);

  const change = useMutation({
    mutationFn: ({ appId, body }: Change) => setAppAccess(space.id, appId, body),
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<SpaceApps>(key, (current) => (current ? applied(current, variables) : current));
    },
    // Whether it was saved or not, the server says what is.
    onSettled: () =>
      Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: SESSION_QUERY_KEY })]),
  });

  // Apps someone can use: those removed from the group or without code on the server are nobody's.
  const apps = list.apps.filter((app) => app.removedAt === null && app.hasCode);
  const members: SpaceMemberDetail[] = list.members.filter((member) => member.role === "member");

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 id={headingId} className="font-medium">
        {t("groups.access")}
      </h3>
      {apps.length === 0 ? (
        <p className="text-xs text-fg-3">
          <LinkedText text={t("groups.accessNoApps")} to="/apps" />
        </p>
      ) : (
        // On a phone the table scrolls sideways inside the card; the page itself does not.
        <div className="-mx-1 overflow-x-auto px-1" data-testid="access-scroller">
          <table aria-labelledby={headingId} className="w-full min-w-max border-collapse text-left">
            <thead>
              <tr className="text-xs text-fg-3">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t("groups.accessApp")}
                </th>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t("groups.accessEveryone")}
                </th>
                {members.map((member) => (
                  <th key={member.id} scope="col" className="py-1.5 pr-3 font-medium">
                    {member.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const { name, icon, color } = label(app.id);
                const everyone = LEVELS.find((level) => level.value === app.memberAccess) ?? LEVELS[0]!;
                return (
                  <tr key={app.id} className="border-t border-line">
                    <th scope="row" className="py-1.5 pr-3 font-normal">
                      <span className="flex items-center gap-2">
                        <AppIcon icon={icon} color={color} />
                        <span>{name}</span>
                      </span>
                    </th>
                    <td className="py-1.5 pr-3">
                      <select
                        aria-label={t("groups.accessEveryoneFor", { app: name })}
                        className={SELECT_CLASS}
                        value={app.memberAccess}
                        onChange={(event) =>
                          change.mutate({ appId: app.id, body: { memberAccess: event.target.value as MemberAccess } })
                        }
                      >
                        {LEVELS.map((level) => (
                          <option key={level.value} value={level.value}>
                            {t(level.label)}
                          </option>
                        ))}
                      </select>
                    </td>
                    {members.map((member) => (
                      <td key={member.id} className="py-1.5 pr-3">
                        <select
                          aria-label={t("groups.accessFor", { name: member.name, app: name })}
                          className={SELECT_CLASS}
                          value={app.members[member.id] ?? AS_EVERYONE}
                          onChange={(event) => {
                            const value = event.target.value;
                            const level = value === AS_EVERYONE ? null : (value as MemberAccess);
                            change.mutate({ appId: app.id, body: { members: { [member.id]: level } } });
                          }}
                        >
                          <option value={AS_EVERYONE}>{t(everyone.asEveryone)}</option>
                          {LEVELS.map((level) => (
                            <option key={level.value} value={level.value}>
                              {t(level.label)}
                            </option>
                          ))}
                        </select>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {change.isError ? (
        <p role="status" className="text-xs text-down">
          {t("groups.accessFailed")}
        </p>
      ) : null}
      <p className="text-xs text-fg-3">{t("groups.accessHint")}</p>
    </div>
  );
}
