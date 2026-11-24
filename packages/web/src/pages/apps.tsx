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
 * - Where the person may add apps, "Add an app" offers the apps shipped with
 *   Hearth (docs/platform.md, "Built-in apps") that the space does not have
 *   yet, each added as an app made in Hearth of the space's own. Any other
 *   app is made in the chat. Adding is a saved setting: no rebuild, no
 *   restart. In a group the person adding is asked who else may use it,
 *   "only me for now" first (owner's decision 1). Moving an app into a
 *   group asks the same.
 * - A built-in app the space had and removed kept its data, and adding it
 *   again brings that back (owner's decision 2). Only an owner can, and for
 *   an owner the dialog reads the owners' list first and says so, with how
 *   many entries come back, so that who else may use it is chosen knowing
 *   that.
 * - A built-in app that names hosts in `network` fetches from them, through
 *   the server, and the dialog says so under its description, new or
 *   brought back (owner's decision 14). It asks nothing more: the app ships
 *   with Hearth.
 * - An owner sees each space's removed apps under "Removed apps", with how
 *   many entries each holds: "Bring back" returns one with its data (asking,
 *   in a group, who else may use it), and "Delete permanently" deletes it for
 *   good. An app in use can be deleted for good too, from its Remove dialog.
 *   Deleting for good asks for the app's name to be typed, says how many
 *   entries go and that it cannot be undone; the server checks the name
 *   again. The model in the chat never deletes an app.
 */
import { ArchiveRestore, ArrowRightLeft, ChevronRight, LayoutGrid, Pin, Plus, RefreshCw, Trash2, UserRound, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import type { AppSummary, CatalogApp, InstalledApp, Localized, MemberAccess, Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, EmptyState, IconButton, Input, Row, Rows, Switch, Tag } from "@hearth/sdk/web";
import { useSpaceApps } from "../groups/queries";
import {
  AppSettingsButton,
  useAddApp,
  useAppPrefs,
  useBringBackApp,
  useCatalog,
  useDeleteAppForGood,
  useFullAppName,
  useMoveApp,
  useMoveTargets,
  useRemoveApp,
} from "../apps/manage";
import { AppIcon } from "../components/app-icon";
import { Page } from "../components/shell/page";
import { Card, CardFooter, CardHeader } from "../components/card";
import { LinkedText } from "../components/linked-text";
import { joinNames, pickLocalized, type PlainMessageKey, type Translate } from "../i18n";
import { cx } from "../lib/cx";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { appPath, enabledApps, pinnedFirst, useSession } from "../session/session";

/**
 * What just happened to an app, said in the space it is in now: moved
 * there, brought back, or deleted for good. The row the change was started
 * from is gone, and its dialog with it, so the focus goes to what is said.
 */
type Notice = { spaceId: string; appId: string; name: Localized; kind: "moved" | "back" | "deleted" };

const NOTICE_TEXT = { moved: "apps.moved", back: "apps.isBack", deleted: "apps.deleted" } as const;

export function Apps() {
  const session = useSession();
  const { t } = useI18n();
  const [notice, setNotice] = useState<Notice | null>(null);
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
            notice={notice?.spaceId === space.id ? notice : null}
            onNotice={setNotice}
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

/** A pinned app: a link to its page. */
function ShortcutRow({ app }: { app: AppSummary }) {
  const fullName = useFullAppName(app);
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

function SpaceSection(props: { space: Space; apps: AppSummary[]; notice: Notice | null; onNotice: (notice: Notice) => void }) {
  const { space, apps, notice, onNotice } = props;
  const { t } = useI18n();
  const personal = space.kind === "personal";
  // An app moved here or brought back is said to be here for as long as the space lists it.
  const shownNotice = notice && (notice.kind === "deleted" || apps.some((app) => app.id === notice.appId)) ? notice : null;
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
            <ManagedRow key={app.id} app={app} space={space} onNotice={onNotice} />
          ))}
        </Rows>
      )}
      {shownNotice ? <NoticeLine key={`${shownNotice.kind}/${shownNotice.appId}`} notice={shownNotice} /> : null}
      {space.role === "owner" ? <RemovedApps space={space} onNotice={onNotice} /> : null}
      {space.canAddApps ? <AddApp space={space} /> : null}
    </Card>
  );
}

/** Says what just happened to an app (`Notice`), and takes the focus, whose control went with the change. */
function NoticeLine({ notice }: { notice: Notice }) {
  const { locale, t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p ref={ref} role="status" tabIndex={-1} className="mt-2 rounded-ctl text-xs text-fg-2">
      {t(NOTICE_TEXT[notice.kind], { app: pickLocalized(notice.name, locale) })}
    </p>
  );
}

/** One app in one space, with the person's own switch and pin, its settings and, for an owner, "Move" and "Remove". */
function ManagedRow({ app, space, onNotice }: { app: AppSummary; space: Space; onNotice: (notice: Notice) => void }) {
  const { t } = useI18n();
  const fullName = useFullAppName(app);
  const prefs = useAppPrefs(app);
  const targets = useMoveTargets(app);
  const [moving, setMoving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
      <MoveDialog
        app={app}
        from={space}
        targets={targets}
        open={moving}
        onClose={() => setMoving(false)}
        onMoved={(to) => onNotice({ spaceId: to, appId: app.id, name: app.name, kind: "moved" })}
      />
      <RemoveDialog
        app={app}
        open={removing}
        onClose={() => setRemoving(false)}
        onDeleteInstead={() => {
          setRemoving(false);
          setDeleting(true);
        }}
      />
      {space.role === "owner" ? (
        <DeleteForGoodDialog
          space={space}
          appId={app.id}
          name={app.name}
          open={deleting}
          onClose={() => setDeleting(false)}
          onDeleted={() => onNotice({ spaceId: space.id, appId: app.id, name: app.name, kind: "deleted" })}
        />
      ) : null}
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
  /** Once moved, with the space it went to. */
  onMoved: (toSpaceId: string) => void;
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
          onMoved(chosen.id);
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

/**
 * Asks before an owner removes an app, and says that its data is kept and
 * that it can be brought back. Offers deleting it for good instead, in a
 * dialog of its own.
 */
function RemoveDialog(props: { app: AppSummary; open: boolean; onClose: () => void; onDeleteInstead: () => void }) {
  const { app, open, onClose, onDeleteInstead } = props;
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
        {/* Any removed app comes back from Removed apps; a built-in one also from the Add dialog. */}
        <p className="text-fg-2">{t(app.template ? "apps.removeBody" : "apps.removeBodyMade")}</p>
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button className="mr-auto" aria-haspopup="dialog" disabled={remove.isPending} onClick={onDeleteInstead}>
            {t("apps.deletePermanently")}
          </Button>
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

/** An app's name with its space's, where apps of one name may be listed in two spaces: "Checklist in Family". */
function nameInSpace(name: string, space: Space, t: Translate): string {
  return space.kind === "group" ? t("dashboard.appInSpace", { app: name, space: space.name }) : name;
}

/** How many entries an app holds, in a few words. */
function entriesText(count: number, t: Translate): string {
  if (count === 0) return t("apps.removedEntriesNone");
  return count === 1 ? t("apps.removedEntriesOne") : t("apps.removedEntriesMany", { count });
}

/**
 * The apps the space removed and kept the data of, for its owners, as the
 * owners' list gives them, with "Bring back" and "Delete permanently".
 * Nothing is drawn while there are none. An install the server holds no app
 * for can only be deleted, by its ID.
 */
function RemovedApps({ space, onNotice }: { space: Space; onNotice: (notice: Notice) => void }) {
  const { t } = useI18n();
  const list = useSpaceApps(space);
  const removed = (list.data?.apps ?? []).filter((entry) => entry.removedAt !== null);
  if (list.isError && list.data === undefined) {
    return (
      <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <p className="text-xs text-down">{t("apps.removedLoadFailed")}</p>
        <Button size="sm" onClick={() => void list.refetch()}>
          <RefreshCw size={14} aria-hidden="true" />
          {t("apps.retry")}
        </Button>
      </div>
    );
  }
  if (removed.length === 0) return null;
  return (
    <div className="mt-3 border-t border-line pt-3" data-removed-apps="">
      <CardHeader level={3} icon={<ArchiveRestore size={16} aria-hidden="true" />} title={t("apps.removedTitle")} aside={t("apps.removedNote")} />
      <Rows aria-label={t("apps.removedTitle")}>
        {removed.map((entry) => (
          <RemovedRow key={entry.id} entry={entry} space={space} onNotice={onNotice} />
        ))}
      </Rows>
    </div>
  );
}

/** One removed app: its icon, name and how many entries it holds, with "Bring back" and "Delete permanently". */
function RemovedRow({ entry, space, onNotice }: { entry: InstalledApp; space: Space; onNotice: (notice: Notice) => void }) {
  const { locale, t } = useI18n();
  const [bringing, setBringing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The server holds no app of this ID (an install of an app from before the built-in apps): it has only its ID.
  const name: Localized = entry.name ?? { en: entry.id, zh: entry.id };
  const fullName = nameInSpace(pickLocalized(name, locale), space, t);
  return (
    <Row className="flex-wrap" data-removed-app={entry.id}>
      <span className="flex min-w-[12rem] flex-1 items-center gap-2.5">
        <AppIcon icon={entry.icon ?? "box"} color={entry.color ?? ""} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="clip font-medium">{pickLocalized(name, locale)}</span>
          <span className="text-xs text-fg-3">{entriesText(entry.rowCount, t)}</span>
        </span>
      </span>
      <span className="ml-auto flex flex-none flex-wrap items-center gap-2">
        {entry.hasCode ? (
          <Button size="sm" aria-label={t("apps.bringBackApp", { app: fullName })} aria-haspopup="dialog" onClick={() => setBringing(true)}>
            <ArchiveRestore size={14} aria-hidden="true" />
            {t("apps.bringBack")}
          </Button>
        ) : null}
        <Button size="sm" aria-label={t("apps.deletePermanentlyApp", { app: fullName })} aria-haspopup="dialog" onClick={() => setDeleting(true)}>
          <Trash2 size={14} aria-hidden="true" />
          {t("apps.deletePermanently")}
        </Button>
      </span>
      {entry.hasCode ? (
        <BringBackDialog
          space={space}
          entry={entry}
          name={name}
          open={bringing}
          onClose={() => setBringing(false)}
          onBack={() => onNotice({ spaceId: space.id, appId: entry.id, name, kind: "back" })}
        />
      ) : null}
      <DeleteForGoodDialog
        space={space}
        appId={entry.id}
        name={entry.name ?? null}
        open={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={() => onNotice({ spaceId: space.id, appId: entry.id, name, kind: "deleted" })}
      />
    </Row>
  );
}

type BringBackProps = {
  space: Space;
  entry: InstalledApp;
  name: Localized;
  open: boolean;
  onClose: () => void;
  onBack: () => void;
};

/** Asks an owner to bring a removed app back, says what comes with it, and in a group who else may use it. */
function BringBackDialog(props: BringBackProps) {
  const { locale, t } = useI18n();
  const title = t("apps.bringBackTitle", { app: nameInSpace(pickLocalized(props.name, locale), props.space, t) });
  return (
    <Dialog open={props.open} onClose={props.onClose} label={title}>
      <BringBackForm {...props} title={title} />
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so that it starts from "only me for now". */
function BringBackForm({ space, entry, onClose, onBack, title }: BringBackProps & { title: string }) {
  const { t } = useI18n();
  const name = useId();
  const bring = useBringBackApp();
  const [memberAccess, setMemberAccess] = useState<MemberAccess>("none");
  const group = space.kind === "group";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (bring.isPending) return;
    // Settles once the session and the owners' list are loaded again, which have taken this row, and the dialog, away.
    bring.mutateAsync({ install: { spaceId: space.id, appId: entry.id }, memberAccess: group ? memberAccess : undefined }).then(
      () => {
        onClose();
        onBack();
      },
      () => undefined,
    );
  };

  const failure = bring.error ? failureCode(bring.error) : null;
  const refused = failure === "forbidden" || failure === "conflict" || failure === "not_found";
  const comes =
    entry.rowCount === 0
      ? t("apps.bringBackNone")
      : entry.rowCount === 1
        ? t("apps.bringBackOne")
        : t("apps.bringBackMany", { count: entry.rowCount });

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="text-fg-2">{comes}</p>
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
            {t(refused ? "apps.bringBackRefused" : "apps.bringBackFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={bring.isPending}>
            {t("apps.bringBack")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}

type DeleteForGoodProps = {
  space: Space;
  appId: string;
  /** The app's name in both languages, or null for an install the server holds no app for, which goes by its ID. */
  name: Localized | null;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
};

/**
 * Asks an owner before an app is deleted for good, in use or removed: says
 * how many entries go with it, for whom, and that it cannot be undone, and
 * wants the app's name typed. The server checks the name again.
 */
function DeleteForGoodDialog(props: DeleteForGoodProps) {
  const { locale, t } = useI18n();
  const shown = props.name ? pickLocalized(props.name, locale) : props.appId;
  const title = t("apps.deleteTitle", { app: shown });
  return (
    <Dialog open={props.open} onClose={props.onClose} label={title}>
      <DeleteForGoodForm {...props} shown={shown} title={title} />
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so that the box starts empty. */
function DeleteForGoodForm({ space, appId, name, onClose, onDeleted, shown, title }: DeleteForGoodProps & { shown: string; title: string }) {
  const { t } = useI18n();
  const boxId = useId();
  const remove = useDeleteAppForGood();
  const list = useSpaceApps(space);
  const [typed, setTyped] = useState("");
  // How many entries go: the owners' list counts them. Until it is known, nothing is deleted.
  const count = list.data?.apps.find((entry) => entry.id === appId)?.rowCount;
  // The name in either of its languages, as the server takes it; spaces around it do not count.
  const names = name ? [name.en, name.zh] : [appId];
  const matches = names.some((candidate) => candidate.trim() !== "" && candidate.trim() === typed.trim());
  const personal = space.kind === "personal";

  const body =
    count === undefined
      ? null
      : personal
        ? count === 0
          ? t("apps.deleteBodyNone")
          : count === 1
            ? t("apps.deleteBodyOne")
            : t("apps.deleteBodyMany", { count })
        : count === 0
          ? t("apps.deleteBodyGroupNone", { space: space.name })
          : count === 1
            ? t("apps.deleteBodyGroupOne", { space: space.name })
            : t("apps.deleteBodyGroupMany", { count, space: space.name });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!matches || count === undefined || remove.isPending) return;
    // Settles once the session and the owners' list are loaded again, which have taken this app, and the dialog, away.
    remove.mutateAsync({ install: { spaceId: space.id, appId }, confirm: typed.trim() }).then(
      () => {
        onClose();
        onDeleted();
      },
      () => undefined,
    );
  };

  const failure = remove.error ? failureCode(remove.error) : null;
  const problem: PlainMessageKey | null =
    failure === null
      ? null
      : failure === "invalid_request"
        ? "apps.deleteMismatch"
        : failure === "forbidden"
          ? "apps.deleteRefused"
          : failure === "not_found"
            ? "apps.deleteGone"
            : "apps.deleteFailed";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold [overflow-wrap:anywhere]">{title}</h2>
        {body !== null ? (
          <p className="text-fg-2">{body}</p>
        ) : list.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-down">{t("apps.deleteCheckFailed")}</p>
            <Button size="sm" onClick={() => void list.refetch()}>
              <RefreshCw size={14} aria-hidden="true" />
              {t("apps.retry")}
            </Button>
          </div>
        ) : (
          <p className="text-fg-3">{t("apps.deleteCounting")}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={boxId} className="font-medium [overflow-wrap:anywhere]">
            {t("apps.deleteType", { app: shown })}
          </label>
          <Input
            id={boxId}
            value={typed}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!matches || count === undefined || remove.isPending}>
            {t("apps.deleteConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}

/**
 * The built-in apps that a space does not have yet, and when there are
 * none, why: Hearth ships none, every one of them is here already, or they
 * could not be read. Null while they are being read.
 */
function useAddable(space: Space): { apps: CatalogApp[]; none: PlainMessageKey | null; retry: () => void } {
  const session = useSession();
  const catalog = useCatalog();
  const builtIn = catalog.data ?? [];
  // A space has one of each built-in app: the made app added from it says which.
  const here = (template: CatalogApp) => session.apps.some((app) => app.spaceId === space.id && app.template === template.id);
  const apps = builtIn.filter((template) => !here(template));
  const none: PlainMessageKey | null = catalog.isError
    ? "apps.addLoadFailed"
    : catalog.isPending
      ? null
      : builtIn.length === 0
        ? "apps.addNoneInstalled"
        : "apps.addNothing";
  return { apps, none, retry: () => void catalog.refetch() };
}

function AddApp({ space }: { space: Space }) {
  const { t } = useI18n();
  const { apps: addable, none, retry } = useAddable(space);
  // Asked for with the page, for an owner only, so that the dialog knows which apps the space removed.
  useSpaceApps(space);
  const [open, setOpen] = useState(false);
  // Nothing left to add, as when the session showed that someone else added it first: the dialog
  // goes, and must not open again by itself once there is something to add again.
  if (open && addable.length === 0) setOpen(false);
  return (
    <CardFooter className="flex flex-wrap items-center gap-3">
      {addable.length > 0 ? (
        <>
          <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            {t("apps.add")}
          </Button>
          <AddAppDialog space={space} addable={addable} open={open} onClose={() => setOpen(false)} />
        </>
      ) : none === "apps.addLoadFailed" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-down">{t(none)}</p>
          <Button size="sm" onClick={retry}>
            <RefreshCw size={14} aria-hidden="true" />
            {t("apps.retry")}
          </Button>
        </div>
      ) : none ? (
        <p className="text-xs text-fg-3">
          <LinkedText text={t(none)} to="/chat" />
        </p>
      ) : null}
    </CardFooter>
  );
}

const ACCESS_CHOICES: ReadonlyArray<{ value: MemberAccess; label: PlainMessageKey }> = [
  { value: "none", label: "apps.accessNone" },
  { value: "view", label: "apps.accessView" },
  { value: "edit", label: "apps.accessEdit" },
];

const RADIO = "size-4 flex-none accent-accent";

function AddAppDialog(props: { space: Space; addable: CatalogApp[]; open: boolean; onClose: () => void }) {
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
function AddAppForm({ space, addable, onClose, title }: { space: Space; addable: CatalogApp[]; onClose: () => void; title: string }) {
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
  // A built-in app the space removed is the made app added from it.
  const removed = (app: CatalogApp) =>
    owner ? list.data?.apps.find((entry) => entry.template === app.id && entry.removedAt !== null) : undefined;
  const restoring = chosen ? removed(chosen) !== undefined : false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !known || add.isPending) return;
    // Closed whether or not the dialog is still there when the session is loaded again.
    add.mutateAsync({ spaceId: space.id, templateId: chosen.id, memberAccess: group ? memberAccess : undefined }).then(onClose, () => undefined);
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
            const entry = removed(app);
            const hosts = app.network;
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
                <AppIcon icon={app.icon} color={app.color} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{pickLocalized(app.name, locale)}</span>
                  <span className="text-xs text-fg-3">{pickLocalized(app.description, locale)}</span>
                  {hosts.length > 0 ? (
                    <span className="text-xs text-fg-2 wrap-anywhere">
                      {t("apps.addNetwork", { hosts: joinNames(hosts, locale) })}
                    </span>
                  ) : null}
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
