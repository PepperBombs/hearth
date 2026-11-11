/**
 * The Apps page: every app the person can use, by space, with what they
 * control themselves (docs/mini-app-contract.md, sections A6 and A8).
 *
 * - "Pinned" at the top holds shortcuts to the apps they pinned.
 * - Each space lists its apps, switched off ones included, so that they can
 *   be switched on again. A row has the person's own pin and switch, which
 *   change nothing for anyone else, the app's settings, and for an owner of
 *   the space "Remove", which hides the app for everyone and keeps its data.
 * - Where the person may add apps, "Add an app" offers the apps this build
 *   holds that the space does not have yet. Adding is a saved setting: no
 *   rebuild, no restart. In a group the person adding is asked who else may
 *   use it, "only me for now" first (owner's decision 1).
 */
import { ChevronRight, LayoutGrid, Pin, Plus, Trash2, UserRound, Users } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { AppSummary, MemberAccess, Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, EmptyState, IconButton, Row, Rows, Switch, Tag } from "@hearth/sdk/web";
import { useBundledApps, type BundledApp } from "../apps/bundled";
import { AppSettingsButton, useAddApp, useAppPrefs, useFullAppName, useRemoveApp } from "../apps/manage";
import { AppIcon } from "../components/app-icon";
import { Page } from "../components/shell/page";
import { Card, CardFooter, CardHeader } from "../components/card";
import { pickLocalized, type PlainMessageKey } from "../i18n";
import { cx } from "../lib/cx";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { appPath, enabledApps, pinnedFirst, useSession } from "../session/session";

export function Apps() {
  const session = useSession();
  const { t } = useI18n();
  const pinned = enabledApps(session).filter((app) => app.pinned);
  const spaces = [
    ...session.spaces.filter((space) => space.kind === "personal"),
    ...session.spaces.filter((space) => space.kind === "group"),
  ];

  return (
    <Page title={t("apps.title")}>
      <div className="flex max-w-[760px] flex-col gap-4">
        {session.apps.length === 0 ? (
          <Card className="min-h-[200px] justify-center">
            <EmptyState icon={<LayoutGrid size={20} />} title={t("apps.emptyTitle")}>
              {t("apps.emptyBody")}
            </EmptyState>
          </Card>
        ) : (
          <Card aria-label={t("apps.pinned")}>
            <CardHeader icon={<Pin size={16} aria-hidden="true" />} title={t("apps.pinned")} aside={t("apps.pinnedNote")} />
            {pinned.length === 0 ? (
              <p className="text-xs text-fg-3">{t("apps.pinnedEmpty")}</p>
            ) : (
              <Rows>
                {pinned.map((app) => (
                  <ShortcutRow key={`${app.spaceId}/${app.id}`} app={app} />
                ))}
              </Rows>
            )}
          </Card>
        )}
        {spaces.map((space) => (
          <SpaceSection
            key={space.id}
            space={space}
            apps={pinnedFirst(session.apps.filter((app) => app.spaceId === space.id))}
          />
        ))}
      </div>
    </Page>
  );
}

/** The name and description of an app, cut to one line each. */
function AppText({ app, children }: { app: AppSummary; children?: ReactNode }) {
  const { locale } = useI18n();
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span className="clip font-medium">{pickLocalized(app.name, locale)}</span>
        {children}
      </span>
      <span className="clip text-xs text-fg-3">{pickLocalized(app.description, locale)}</span>
    </span>
  );
}

/** A pinned app: a link to its page, or a note that it has only a widget. */
function ShortcutRow({ app }: { app: AppSummary }) {
  const { t } = useI18n();
  const fullName = useFullAppName(app);
  if (!app.hasPage) {
    return (
      <Row>
        <AppIcon icon={app.icon} color={app.color} />
        <AppText app={app} />
        <Tag>{t("apps.widgetOnly")}</Tag>
      </Row>
    );
  }
  return (
    <Row>
      <Link to={appPath(app)} aria-label={fullName} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-ctl">
        <AppIcon icon={app.icon} color={app.color} />
        <AppText app={app} />
        <ChevronRight size={16} aria-hidden="true" className="text-fg-3" />
      </Link>
    </Row>
  );
}

function SpaceSection({ space, apps }: { space: Space; apps: AppSummary[] }) {
  const { t } = useI18n();
  const personal = space.kind === "personal";
  return (
    <Card aria-label={personal ? t("nav.personal") : space.name}>
      <CardHeader
        icon={personal ? <UserRound size={16} aria-hidden="true" /> : <Users size={16} aria-hidden="true" />}
        title={personal ? t("nav.personal") : space.name}
        aside={personal ? t("apps.onlyYou") : t("apps.shared")}
      />
      {apps.length === 0 ? (
        <p className="text-xs text-fg-3">{personal ? t("apps.personalEmpty") : t("apps.groupEmpty")}</p>
      ) : (
        <Rows>
          {apps.map((app) => (
            <ManagedRow key={app.id} app={app} space={space} />
          ))}
        </Rows>
      )}
      {space.canAddApps ? <AddApp space={space} /> : null}
    </Card>
  );
}

/** One app in one space, with the person's own switch and pin, its settings and, for an owner, "Remove". */
function ManagedRow({ app, space }: { app: AppSummary; space: Space }) {
  const { t } = useI18n();
  const fullName = useFullAppName(app);
  const prefs = useAppPrefs(app);
  const [removing, setRemoving] = useState(false);
  const off = !app.enabled;

  const text = (
    <>
      <AppIcon icon={app.icon} color={app.color} />
      <AppText app={app}>{app.access === "view" ? <Tag className="flex-none">{t("apps.viewOnly")}</Tag> : null}</AppText>
    </>
  );

  return (
    <Row className="flex-wrap" data-app-row={app.id}>
      {app.hasPage && !off ? (
        <Link to={appPath(app)} aria-label={fullName} className="flex min-w-[12rem] flex-1 items-center gap-2.5 rounded-ctl">
          {text}
        </Link>
      ) : (
        <span className={cx("flex min-w-[12rem] flex-1 items-center gap-2.5", off && "opacity-60")}>{text}</span>
      )}
      <span className="ml-auto flex flex-none items-center gap-0.5">
        <IconButton
          label={t("apps.pin", { app: fullName })}
          aria-pressed={app.pinned}
          className="aria-pressed:text-accent"
          onClick={() => prefs.mutate({ pinned: !app.pinned })}
        >
          <Pin size={16} aria-hidden="true" fill={app.pinned ? "currentColor" : "none"} />
        </IconButton>
        <AppSettingsButton app={app} />
        {space.role === "owner" ? (
          <IconButton label={t("apps.remove", { app: fullName })} aria-haspopup="dialog" onClick={() => setRemoving(true)}>
            <Trash2 size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        <Switch
          className="mr-1 ml-2"
          label={t("apps.show", { app: fullName })}
          checked={app.enabled}
          onCheckedChange={(enabled) => prefs.mutate({ enabled })}
        />
      </span>
      {off || prefs.isError ? (
        <p role="status" className={cx("basis-full text-xs", prefs.isError ? "text-down" : "text-fg-3")}>
          {prefs.isError ? t("apps.changeFailed") : t("apps.off")}
        </p>
      ) : null}
      <RemoveDialog app={app} open={removing} onClose={() => setRemoving(false)} />
    </Row>
  );
}

/** Asks before an owner removes an app, and says that its data is kept. */
function RemoveDialog({ app, open, onClose }: { app: AppSummary; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const fullName = useFullAppName(app);
  const remove = useRemoveApp();
  const title = t("apps.removeTitle", { app: fullName });
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} label={title}>
      <DialogBody>
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="text-fg-2">{t("apps.removeBody")}</p>
        {remove.isError ? (
          <p role="status" className="text-xs text-down">
            {t("apps.removeFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t("apps.cancel")}</Button>
          <Button
            variant="primary"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ spaceId: app.spaceId, appId: app.id }, { onSuccess: close })}
          >
            {t("apps.removeConfirm")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}

/** The apps this build holds that a space does not have yet and whose manifest allows its kind. */
function useAddable(space: Space): BundledApp[] {
  const session = useSession();
  const bundled = useBundledApps();
  const present = new Set(session.apps.filter((app) => app.spaceId === space.id).map((app) => app.id));
  return bundled.filter((app) => !present.has(app.id) && (!app.manifest.spaces || app.manifest.spaces.includes(space.kind)));
}

function AddApp({ space }: { space: Space }) {
  const { t } = useI18n();
  const addable = useAddable(space);
  const [open, setOpen] = useState(false);
  return (
    <CardFooter className="flex flex-wrap items-center gap-3">
      {addable.length === 0 ? (
        <p className="text-xs text-fg-3">{t("apps.addNothing")}</p>
      ) : (
        <>
          <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            {t("apps.add")}
          </Button>
          <AddAppDialog space={space} addable={addable} open={open} onClose={() => setOpen(false)} />
        </>
      )}
    </CardFooter>
  );
}

const ACCESS_CHOICES: ReadonlyArray<{ value: MemberAccess; label: PlainMessageKey }> = [
  { value: "none", label: "apps.accessNone" },
  { value: "view", label: "apps.accessView" },
  { value: "edit", label: "apps.accessEdit" },
];

const RADIO = "size-4 flex-none accent-accent";

function AddAppDialog(props: { space: Space; addable: BundledApp[]; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const title = props.space.kind === "group" ? t("apps.addTo", { space: props.space.name }) : t("apps.addToPersonal");
  return (
    <Dialog open={props.open} onClose={props.onClose} label={title}>
      <AddAppForm {...props} title={title} />
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so that it starts from the first app and "only me for now". */
function AddAppForm({ space, addable, onClose, title }: { space: Space; addable: BundledApp[]; onClose: () => void; title: string }) {
  const { locale, t } = useI18n();
  const name = useId();
  const add = useAddApp();
  const [chosen, setChosen] = useState(addable[0]?.id ?? "");
  const [memberAccess, setMemberAccess] = useState<MemberAccess>("none");
  const group = space.kind === "group";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!addable.some((app) => app.id === chosen) || add.isPending) return;
    add.mutate(
      { install: { spaceId: space.id, appId: chosen }, memberAccess: group ? memberAccess : undefined },
      { onSuccess: onClose },
    );
  };

  const failure = add.error ? failureCode(add.error) : null;
  const refused = failure === "forbidden" || failure === "conflict";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("apps.addChoose")}</legend>
          {addable.map((app) => (
            <label
              key={app.id}
              className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border border-line px-2.5 py-2 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name={`${name}-app`}
                value={app.id}
                className={RADIO}
                checked={chosen === app.id}
                onChange={() => setChosen(app.id)}
              />
              <AppIcon icon={app.manifest.icon} color={app.manifest.color} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{pickLocalized(app.manifest.name, locale)}</span>
                <span className="text-xs text-fg-3">{pickLocalized(app.manifest.description, locale)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {group ? (
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("apps.addWho")}</legend>
            {ACCESS_CHOICES.map((choice) => (
              <label key={choice.value} className="flex min-h-7 cursor-pointer items-center gap-2.5 max-md:min-h-11">
                <input
                  type="radio"
                  name={`${name}-access`}
                  value={choice.value}
                  className={RADIO}
                  checked={memberAccess === choice.value}
                  onChange={() => setMemberAccess(choice.value)}
                />
                <span>{t(choice.label)}</span>
              </label>
            ))}
            <p className="text-xs text-fg-3">{t("apps.addWhoHint")}</p>
          </fieldset>
        ) : null}
        {failure ? (
          <p role="status" className="text-xs text-down">
            {t(refused ? "apps.addRefused" : "apps.addFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={add.isPending || chosen === ""}>
            {t("apps.addConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}
