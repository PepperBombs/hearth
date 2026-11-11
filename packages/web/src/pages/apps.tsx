/**
 * The Apps page: every app the person can use, by space, with what they
 * control themselves (docs/mini-app-contract.md, sections A6 and A8).
 *
 * - "Pinned" at the top holds shortcuts to the apps they pinned.
 * - Each space lists its apps, switched off ones included, so that they can
 *   be switched on again. A row has the person's own pin and switch, which
 *   change nothing for anyone else, the app's settings, and for an owner of
 *   the space "Move", which takes the app with its data to another space,
 *   and "Remove", which hides the app for everyone and keeps its data.
 * - Where the person may add apps, "Add an app" offers the apps this build
 *   holds that the space does not have yet. Adding is a saved setting: no
 *   rebuild, no restart. In a group the person adding is asked who else may
 *   use it, "only me for now" first (owner's decision 1). Moving an app into
 *   a group asks the same.
 * - An app the space had and removed kept its data, and adding it again
 *   brings that back (owner's decision 2). Only an owner can, and for an
 *   owner the dialog reads the owners' list first and says so, with how many
 *   entries come back, so that who else may use it is chosen knowing that.
 */
import { ArrowRightLeft, ChevronRight, LayoutGrid, Pin, Plus, RefreshCw, Trash2, UserRound, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { AppSummary, InstalledApp, Localized, MemberAccess, Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, EmptyState, IconButton, Row, Rows, Switch, Tag } from "@hearth/sdk/web";
import { useBundledApps, type BundledApp } from "../apps/bundled";
import { useSpaceApps } from "../groups/queries";
import {
  AppSettingsButton,
  useAddApp,
  useAppPrefs,
  useFullAppName,
  useMoveApp,
  useMoveTargets,
  useRemoveApp,
} from "../apps/manage";
import { AppIcon } from "../components/app-icon";
import { Page } from "../components/shell/page";
import { Card, CardFooter, CardHeader } from "../components/card";
import { pickLocalized, type PlainMessageKey, type Translate } from "../i18n";
import { cx } from "../lib/cx";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { appPath, enabledApps, pinnedFirst, useSession } from "../session/session";

/** An app that was just moved, and where to: the space it went to says so. */
type Moved = { spaceId: string; appId: string; name: Localized };

export function Apps() {
  const session = useSession();
  const { t } = useI18n();
  const [moved, setMoved] = useState<Moved | null>(null);
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
            moved={moved?.spaceId === space.id ? moved : null}
            onMoved={setMoved}
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

function SpaceSection(props: { space: Space; apps: AppSummary[]; moved: Moved | null; onMoved: (moved: Moved) => void }) {
  const { space, apps, moved, onMoved } = props;
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
            <ManagedRow key={app.id} app={app} space={space} onMoved={onMoved} />
          ))}
        </Rows>
      )}
      {moved && apps.some((app) => app.id === moved.appId) ? <MovedNotice key={moved.appId} moved={moved} /> : null}
      {space.canAddApps ? <AddApp space={space} /> : null}
    </Card>
  );
}

/**
 * Says, in the space an app was just moved to, that it is there now, for
 * as long as the space lists it. The row the move was started from is gone,
 * and its dialog with it, so the focus comes here.
 */
function MovedNotice({ moved }: { moved: Moved }) {
  const { locale, t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p ref={ref} role="status" tabIndex={-1} className="mt-2 rounded-ctl text-xs text-fg-2">
      {t("apps.moved", { app: pickLocalized(moved.name, locale) })}
    </p>
  );
}

/** One app in one space, with the person's own switch and pin, its settings and, for an owner, "Move" and "Remove". */
function ManagedRow({ app, space, onMoved }: { app: AppSummary; space: Space; onMoved: (moved: Moved) => void }) {
  const { t } = useI18n();
  const fullName = useFullAppName(app);
  const prefs = useAppPrefs(app);
  const targets = useMoveTargets(app);
  const [moving, setMoving] = useState(false);
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
        {targets.length > 0 ? (
          <IconButton label={t("apps.move", { app: fullName })} aria-haspopup="dialog" onClick={() => setMoving(true)}>
            <ArrowRightLeft size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
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
      <MoveDialog app={app} from={space} targets={targets} open={moving} onClose={() => setMoving(false)} onMoved={onMoved} />
      <RemoveDialog app={app} open={removing} onClose={() => setRemoving(false)} />
    </Row>
  );
}

type MoveDialogProps = {
  app: AppSummary;
  from: Space;
  /** Where the person may move it, from `useMoveTargets`. The dialog is opened only when there is somewhere. */
  targets: Space[];
  open: boolean;
  onClose: () => void;
  onMoved: (moved: Moved) => void;
};

/**
 * Asks an owner where an app goes and, for a group, who there may use it,
 * "only me for now" first, as when an app is added; says what goes along
 * and, from a group, who loses it.
 */
function MoveDialog(props: MoveDialogProps) {
  const { t } = useI18n();
  const title = t("apps.moveTitle", { app: useFullAppName(props.app) });
  return (
    <Dialog open={props.open} onClose={props.onClose} label={title}>
      <MoveForm {...props} title={title} />
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so that it starts from the first space offered and "only me for now". */
function MoveForm({ app, from, targets, onClose, onMoved, title }: MoveDialogProps & { title: string }) {
  const { t } = useI18n();
  const name = useId();
  const move = useMoveApp();
  const [chosenId, setChosenId] = useState(targets[0]?.id ?? "");
  const [memberAccess, setMemberAccess] = useState<MemberAccess>("none");
  // The session is loaded again while the dialog is open; a space it no longer offers is not chosen.
  const chosen = targets.find((space) => space.id === chosenId) ?? targets[0];
  const group = chosen?.kind === "group";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || move.isPending) return;
    // Settles once the session is loaded again, which has taken this row, and the dialog, away.
    move
      .mutateAsync({ install: { spaceId: app.spaceId, appId: app.id }, toSpaceId: chosen.id, memberAccess: group ? memberAccess : undefined })
      .then(
        () => {
          onClose();
          onMoved({ spaceId: chosen.id, appId: app.id, name: app.name });
        },
        // The dialog shows the failure; nothing else waits for it.
        () => undefined,
      );
  };

  const failure = move.error ? failureCode(move.error) : null;
  const refused = failure === "forbidden" || failure === "conflict" || failure === "not_found";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("apps.moveTo")}</legend>
          {targets.map((space) => {
            const personal = space.kind === "personal";
            return (
              <label
                key={space.id}
                className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border border-line px-2.5 py-2 has-checked:border-accent has-checked:bg-accent-soft"
              >
                <input
                  type="radio"
                  name={`${name}-space`}
                  value={space.id}
                  className={RADIO}
                  checked={chosen?.id === space.id}
                  onChange={() => setChosenId(space.id)}
                />
                {personal ? (
                  <UserRound size={16} aria-hidden="true" className="flex-none text-fg-2" />
                ) : (
                  <Users size={16} aria-hidden="true" className="flex-none text-fg-2" />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="clip font-medium">{personal ? t("nav.personal") : space.name}</span>
                  <span className="text-xs text-fg-3">{personal ? t("apps.onlyYou") : t("apps.shared")}</span>
                </span>
              </label>
            );
          })}
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
        <p className="text-fg-2">{t("apps.moveBody")}</p>
        {from.kind === "group" ? <p className="text-fg-2">{t("apps.moveOthers")}</p> : null}
        {failure ? (
          <p role="status" className="text-xs text-down">
            {t(refused ? "apps.moveRefused" : "apps.moveFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={move.isPending || !chosen}>
            {t("apps.moveConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
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
  // By the time a refusal shows, the session is loaded again: an app someone else removed has gone
  // from the page with this dialog, and someone who is no longer an owner has lost "Remove".
  const failure = remove.error ? failureCode(remove.error) : null;
  const problem =
    failure === "not_found" ? "apps.removeGone" : failure === "forbidden" ? "apps.removeRefused" : failure ? "apps.removeFailed" : null;
  return (
    <Dialog open={open} onClose={close} label={title}>
      <DialogBody>
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="text-fg-2">{t("apps.removeBody")}</p>
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
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

/**
 * The apps this build holds that a space does not list for this person and
 * whose manifest allows its kind, and when there are none, why: the build
 * holds no apps at all (a plain `pnpm build` holds none), every one of them
 * is here already, or the others are not for this kind of space.
 */
function useAddable(space: Space): { apps: BundledApp[]; none: PlainMessageKey } {
  const session = useSession();
  const bundled = useBundledApps();
  const present = new Set(session.apps.filter((app) => app.spaceId === space.id).map((app) => app.id));
  const apps = bundled.filter((app) => !present.has(app.id) && (!app.manifest.spaces || app.manifest.spaces.includes(space.kind)));
  const none: PlainMessageKey =
    bundled.length === 0 ? "apps.addNoneInstalled" : bundled.every((app) => present.has(app.id)) ? "apps.addNothing" : "apps.addNothingFits";
  return { apps, none };
}

function AddApp({ space }: { space: Space }) {
  const { t } = useI18n();
  const { apps: addable, none } = useAddable(space);
  // Asked for with the page, for an owner only, so that the dialog knows which apps the space removed.
  useSpaceApps(space);
  const [open, setOpen] = useState(false);
  // Nothing left to add, as when the session showed that someone else added it first: the dialog
  // goes, and must not open again by itself once there is something to add again.
  if (open && addable.length === 0) setOpen(false);
  return (
    <CardFooter className="flex flex-wrap items-center gap-3">
      {addable.length === 0 ? (
        <p className="text-xs text-fg-3">{t(none)}</p>
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

/** What adding an app the space removed brings back, as the owners' list counts it. */
function restoreNote(entry: InstalledApp, t: Translate): string {
  if (entry.rowCount === 0) return t("apps.addRestoreNone");
  return entry.rowCount === 1 ? t("apps.addRestoreOne") : t("apps.addRestoreMany", { count: entry.rowCount });
}

/** Mounted each time the dialog opens, so that it starts from the first app and "only me for now". */
function AddAppForm({ space, addable, onClose, title }: { space: Space; addable: BundledApp[]; onClose: () => void; title: string }) {
  const { locale, t } = useI18n();
  const name = useId();
  const add = useAddApp();
  const list = useSpaceApps(space);
  const [chosenId, setChosenId] = useState(addable[0]?.id ?? "");
  const [memberAccess, setMemberAccess] = useState<MemberAccess>("none");
  // The session is loaded again after a refusal; an app it no longer offers is not chosen.
  const chosen = addable.find((app) => app.id === chosenId) ?? addable[0];
  const group = space.kind === "group";
  const owner = space.role === "owner";
  // Only an owner brings a removed app back (anyone else is turned down), and only an owner may read
  // the list that says which were removed. Until it is known, nothing is added.
  const known = !owner || list.data !== undefined;
  const removed = (appId: string) => (owner ? list.data?.apps.find((entry) => entry.id === appId && entry.removedAt !== null) : undefined);
  const restoring = chosen ? removed(chosen.id) !== undefined : false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !known || add.isPending) return;
    // Closed whether or not the dialog is still there when the session is loaded again.
    add
      .mutateAsync({ install: { spaceId: space.id, appId: chosen.id }, memberAccess: group ? memberAccess : undefined })
      .then(onClose, () => undefined);
  };

  // By the time a refusal shows, the session is loaded again, and the space says what it has.
  const failure = add.error ? failureCode(add.error) : null;
  const problem: PlainMessageKey | null =
    failure === null
      ? null
      : failure === "not_found"
        ? "apps.addGone"
        : failure === "forbidden" || failure === "conflict"
          ? owner
            ? "apps.addConflict"
            : "apps.addRefused"
          : "apps.addFailed";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("apps.addChoose")}</legend>
          {addable.map((app) => {
            const entry = removed(app.id);
            return (
              <label
                key={app.id}
                className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border border-line px-2.5 py-2 has-checked:border-accent has-checked:bg-accent-soft"
              >
                <input
                  type="radio"
                  name={`${name}-app`}
                  value={app.id}
                  className={RADIO}
                  checked={chosen?.id === app.id}
                  onChange={() => setChosenId(app.id)}
                />
                <AppIcon icon={app.manifest.icon} color={app.manifest.color} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{pickLocalized(app.manifest.name, locale)}</span>
                  <span className="text-xs text-fg-3">{pickLocalized(app.manifest.description, locale)}</span>
                  {entry ? <span className="text-xs font-medium text-fg-2">{restoreNote(entry, t)}</span> : null}
                </span>
              </label>
            );
          })}
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
        {owner && list.isError && !known ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-down">{t("apps.addCheckFailed")}</p>
            <Button size="sm" onClick={() => void list.refetch()}>
              <RefreshCw size={14} aria-hidden="true" />
              {t("apps.retry")}
            </Button>
          </div>
        ) : null}
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={add.isPending || !chosen || !known}>
            {t(restoring ? "apps.addRestoreConfirm" : "apps.addConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}
