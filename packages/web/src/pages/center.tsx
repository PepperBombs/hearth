/**
 * The app center (docs/center.md): the apps people published to the
 * person's groups, and the apps Hearth ships.
 *
 * - "From Hearth" lists the built-in apps (`GET /api/catalog`), as the Add
 *   dialog on the Apps page offers them; they are added to a space there.
 * - One section for each group the person is in, "In Family", lists what is
 *   published there (`GET /api/center`): its icon, name and description in
 *   its maker's words, who published it and when, its revision and note, the
 *   collections and fields it keeps, and the line that says what it may do.
 *   An owner of the group may unpublish someone else's app there.
 * - "Add a copy" on each of them asks where: the group it is published to,
 *   when the person may add apps there, or their personal space, the only
 *   places a copy may go; in a group, who else may use it, "only me for
 *   now" first. A space that holds a copy already says so, with "Open".
 *   Once added: "Open" and "Change it in the chat".
 * - "Mine" lists what the person published, with "Unpublish". Copies keep
 *   working when their app is unpublished.
 *
 * Which of the person's spaces already hold a copy is read from the session
 * (`AppSummary.source.listingId`), never from the center's answer.
 */
import { LayoutGrid, Plus, RefreshCw, ShieldCheck, Upload, UserRound, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { AddCopyResult, CenterListing, Localized, MemberAccess, Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, Row, Rows, Tag, buttonClass } from "@hearth/sdk/web";
import { CHOICE, RADIO, WhoCanUse } from "../apps/add-parts";
import { useCatalog } from "../apps/manage";
import { useAddCopy, useCenter, useUnpublish } from "../center/api";
import { AppIcon } from "../components/app-icon";
import { Card, CardHeader } from "../components/card";
import { LinkedText } from "../components/linked-text";
import { Page } from "../components/shell/page";
import { joinNames, pickLocalized, type PlainMessageKey, type Translate } from "../i18n";
import { formatDay } from "../lib/date";
import { useToday } from "../lib/use-today";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { appPath, useSession } from "../session/session";

/** An app just unpublished, said at the top of the page: its row, and the button that was in it, are gone. */
type Notice = { id: string; name: Localized };

export function Center() {
  const session = useSession();
  const { t } = useI18n();
  const center = useCenter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const groups = session.spaces.filter((space) => space.kind === "group");
  const listings = center.data ?? [];
  const mine = listings.filter((listing) => listing.mine);

  return (
    <Page title={t("center.title")}>
      <div className="flex max-w-[760px] flex-col gap-4">
        <p className="text-fg-2">{t("center.intro")}</p>
        {notice ? <NoticeLine key={notice.id} notice={notice} /> : null}
        <FromHearth />
        {center.isPending ? (
          <p role="status" className="text-xs text-fg-3">
            {t("center.loading")}
          </p>
        ) : center.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-down">{t("center.loadFailed")}</p>
            <Button size="sm" onClick={() => void center.refetch()}>
              <RefreshCw size={14} aria-hidden="true" />
              {t("apps.retry")}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <Card aria-label={t("center.title")}>
            <p className="text-xs text-fg-3">{t("center.noGroups")}</p>
          </Card>
        ) : (
          <>
            {groups.map((group) => (
              <GroupSection
                key={group.id}
                group={group}
                listings={listings.filter((listing) => listing.spaceId === group.id)}
                onUnpublished={setNotice}
              />
            ))}
            {mine.length > 0 ? <Mine listings={mine} groups={groups} onUnpublished={setNotice} /> : null}
          </>
        )}
      </div>
    </Page>
  );
}

/** Says which app was just unpublished, and takes the focus, whose button went with it. */
function NoticeLine({ notice }: { notice: Notice }) {
  const { locale, t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p ref={ref} role="status" tabIndex={-1} className="rounded-ctl text-xs text-fg-2">
      {t("center.unpublished", { app: pickLocalized(notice.name, locale) })}
    </p>
  );
}

/** The apps Hearth ships, as the Add dialog offers them. They are added to a space on the Apps page. */
function FromHearth() {
  const { locale, t } = useI18n();
  const catalog = useCatalog();
  const apps = catalog.data ?? [];
  return (
    <Card aria-label={t("center.fromHearth")}>
      <CardHeader icon={<LayoutGrid size={16} aria-hidden="true" />} title={t("center.fromHearth")} />
      {catalog.isPending ? null : catalog.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-down">{t("apps.addLoadFailed")}</p>
          <Button size="sm" onClick={() => void catalog.refetch()}>
            <RefreshCw size={14} aria-hidden="true" />
            {t("apps.retry")}
          </Button>
        </div>
      ) : apps.length === 0 ? (
        <p className="text-xs text-fg-3">{t("center.hearthNone")}</p>
      ) : (
        <>
          <Rows>
            {apps.map((app) => (
              <Row key={app.id} className="items-start">
                <AppIcon icon={app.icon} color={app.color} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{pickLocalized(app.name, locale)}</span>
                  <span className="text-xs text-fg-3">{pickLocalized(app.description, locale)}</span>
                  {app.network.length > 0 ? (
                    <span className="text-xs text-fg-2">{t("apps.addNetwork", { hosts: joinNames(app.network, locale) })}</span>
                  ) : null}
                </span>
              </Row>
            ))}
          </Rows>
          <p className="mt-2 text-xs text-fg-3">
            <LinkedText text={t("center.fromHearthNote")} to="/apps" />
          </p>
        </>
      )}
    </Card>
  );
}

/** What is published to one group. An owner of the group may unpublish someone else's app here. */
function GroupSection(props: { group: Space; listings: CenterListing[]; onUnpublished: (notice: Notice) => void }) {
  const { group, listings, onUnpublished } = props;
  const { t } = useI18n();
  const title = t("center.inGroup", { group: group.name });
  return (
    <Card aria-label={title}>
      <CardHeader icon={<Users size={16} aria-hidden="true" />} title={title} />
      {listings.length === 0 ? (
        <p className="text-xs text-fg-3">{t("center.groupEmpty")}</p>
      ) : (
        <Rows>
          {listings.map((listing) => (
            <ListingRow key={listing.id} listing={listing} group={group} onUnpublished={onUnpublished} />
          ))}
        </Rows>
      )}
    </Card>
  );
}

/** "Revision 2: what changed", the note in the publisher's words. */
function revisionText(listing: CenterListing, t: Translate): string {
  return listing.note === ""
    ? t("center.revision", { revision: listing.revision })
    : t("center.revisionNote", { revision: listing.revision, note: listing.note });
}

/** One published app, as the people of its group see it. */
function ListingRow(props: { listing: CenterListing; group: Space; onUnpublished: (notice: Notice) => void }) {
  const { listing, group, onUnpublished } = props;
  const { locale, t } = useI18n();
  const today = useToday();
  const when = formatDay(new Date(listing.updatedAt), today, locale);
  return (
    <Row className="flex-wrap items-start py-3" data-listing={listing.id}>
      <AppIcon icon={listing.icon} color={listing.color} />
      <div className="flex min-w-0 flex-1 basis-[12rem] flex-col gap-1">
        <h3 className="font-medium">{pickLocalized(listing.name, locale)}</h3>
        <p className="text-xs text-fg-3">
          {listing.mine ? t("center.byYou", { when }) : t("center.by", { name: listing.publishedBy.name, when })}
        </p>
        <p className="text-fg-2">{pickLocalized(listing.description, locale)}</p>
        <p className="text-xs text-fg-2">{revisionText(listing, t)}</p>
        <Keeps listing={listing} />
        <p className="flex items-start gap-1.5 text-xs text-fg-3">
          <ShieldCheck size={14} aria-hidden="true" className="mt-px flex-none" />
          <span>{t("center.trust")}</span>
        </p>
      </div>
      <div className="ml-auto flex flex-none flex-wrap justify-end gap-2">
        <AddCopyButton listing={listing} group={group} />
        {/* The publisher unpublishes from "Mine"; an owner of the group may unpublish anyone's here. */}
        {listing.canUnpublish && !listing.mine ? <UnpublishButton listing={listing} group={group} onUnpublished={onUnpublished} /> : null}
      </div>
    </Row>
  );
}

/** The collections a published app keeps, each with its fields, as their names are in its manifest. */
function Keeps({ listing }: { listing: CenterListing }) {
  const { locale, t } = useI18n();
  if (listing.collections.length === 0) return <p className="text-xs text-fg-3">{t("center.keepsNothing")}</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
      <span>{t("center.keeps")}</span>
      <ul className="contents">
        {listing.collections.map((collection) => (
          <li key={collection.name} className="contents">
            {/* Not a Tag, which stays on one line: every field is shown, wrapped on a phone. */}
            <span className="rounded-ctl bg-surface-2 px-1.5 py-0.5 font-medium text-fg-2 wrap-anywhere">
              {collection.fields.length === 0 ? collection.name : `${collection.name}: ${joinNames(collection.fields, locale)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the person published, in every group, with "Unpublish". */
function Mine(props: { listings: CenterListing[]; groups: Space[]; onUnpublished: (notice: Notice) => void }) {
  const { listings, groups, onUnpublished } = props;
  const { locale, t } = useI18n();
  return (
    <Card aria-label={t("center.mine")}>
      <CardHeader icon={<Upload size={16} aria-hidden="true" />} title={t("center.mine")} aside={t("center.mineNote")} />
      <Rows>
        {listings.map((listing) => {
          const group = groups.find((space) => space.id === listing.spaceId);
          if (!group) return null;
          return (
            <Row key={listing.id} className="flex-wrap">
              <AppIcon icon={listing.icon} color={listing.color} />
              <span className="flex min-w-0 flex-1 basis-[10rem] flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="clip font-medium">{pickLocalized(listing.name, locale)}</span>
                  <Tag className="flex-none">{group.name}</Tag>
                </span>
                <span className="text-xs text-fg-3">{revisionText(listing, t)}</span>
              </span>
              <UnpublishButton listing={listing} group={group} onUnpublished={onUnpublished} />
            </Row>
          );
        })}
      </Rows>
    </Card>
  );
}

function UnpublishButton(props: { listing: CenterListing; group: Space; onUnpublished: (notice: Notice) => void }) {
  const { listing, group, onUnpublished } = props;
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const name = pickLocalized(listing.name, locale);
  return (
    <>
      <Button
        size="sm"
        className="ml-auto flex-none"
        aria-haspopup="dialog"
        aria-label={t("center.unpublishApp", { app: name, group: group.name })}
        onClick={() => setOpen(true)}
      >
        {t("center.unpublish")}
      </Button>
      <UnpublishDialog
        listing={listing}
        group={group}
        open={open}
        onClose={() => setOpen(false)}
        onUnpublished={() => onUnpublished({ id: listing.id, name: listing.name })}
      />
    </>
  );
}

/** Asks before unpublishing, and says that copies keep working. */
function UnpublishDialog(props: { listing: CenterListing; group: Space; open: boolean; onClose: () => void; onUnpublished: () => void }) {
  const { listing, group, open, onClose, onUnpublished } = props;
  const { locale, t } = useI18n();
  const unpublish = useUnpublish();
  const title = t("center.unpublishTitle", { app: pickLocalized(listing.name, locale), group: group.name });
  const close = () => {
    unpublish.reset();
    onClose();
  };
  const confirm = () => {
    if (unpublish.isPending) return;
    const done = () => {
      onClose();
      onUnpublished();
    };
    // The center is read again whatever the server answered, which can take this dialog away with
    // its row before the callbacks of one `mutate` would run (docs/notes/web.md). An app someone
    // else unpublished first is gone all the same, and said so.
    unpublish.mutateAsync(listing.id).then(done, (error: unknown) => {
      if (failureCode(error) === "not_found") done();
    });
  };
  const failure = unpublish.error ? failureCode(unpublish.error) : null;
  const problem: PlainMessageKey | null =
    failure === null
      ? null
      : failure === "forbidden"
        ? "center.unpublishRefused"
        : "center.unpublishFailed";
  return (
    <Dialog open={open} onClose={close} label={title}>
      <DialogBody>
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="text-fg-2">{t("center.unpublishBody", { group: group.name })}</p>
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={close}>{t("apps.cancel")}</Button>
          <Button variant="primary" disabled={unpublish.isPending} onClick={confirm}>
            {t("center.unpublish")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}

function AddCopyButton({ listing, group }: { listing: CenterListing; group: Space }) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const name = pickLocalized(listing.name, locale);
  const title = t("center.addCopyTitle", { app: name });
  return (
    <>
      <Button size="sm" className="flex-none" aria-haspopup="dialog" aria-label={t("center.addCopyOf", { app: name })} onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden="true" />
        {t("center.addCopy")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} label={title}>
        <AddCopyForm listing={listing} group={group} title={title} onClose={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

/**
 * Mounted each time the dialog opens, so that it starts from the first space
 * without a copy and "only me for now". A copy may go only to the group the
 * app is published to, where the person may add apps, or to their personal
 * space (docs/center.md, decision 3).
 */
function AddCopyForm(props: { listing: CenterListing; group: Space; title: string; onClose: () => void }) {
  const { listing, group, title, onClose } = props;
  const session = useSession();
  const { locale, t } = useI18n();
  const name = useId();
  const add = useAddCopy();
  const app = pickLocalized(listing.name, locale);
  const personal = session.spaces.find((space) => space.kind === "personal");
  const places = [personal, group.canAddApps ? group : undefined].filter((space): space is Space => space !== undefined);
  // Which spaces hold a copy already, as the session lists the apps the person sees there.
  const copyIn = (space: Space) => session.apps.find((entry) => entry.spaceId === space.id && entry.source?.listingId === listing.id);
  const free = places.filter((space) => copyIn(space) === undefined);
  const [chosenId, setChosenId] = useState(free[0]?.id ?? "");
  const [memberAccess, setMemberAccess] = useState<MemberAccess>("none");
  const [added, setAdded] = useState<(AddCopyResult & { space: Space }) | null>(null);
  // The session is loaded again after a refusal; a space that now holds a copy is not chosen.
  const chosen = free.find((space) => space.id === chosenId) ?? free[0];
  const inGroup = chosen?.kind === "group";

  if (added) return <Added added={added} app={app} onClose={onClose} />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || add.isPending) return;
    // Settles once the session is loaded again, so that the copy is in it when it is offered.
    add.mutateAsync({ spaceId: chosen.id, id: listing.id, memberAccess: inGroup ? memberAccess : undefined }).then(
      (result) => setAdded({ ...result, space: chosen }),
      // The dialog shows the failure; nothing else waits for it.
      () => undefined,
    );
  };

  const failure = add.error ? failureCode(add.error) : null;
  const problem: PlainMessageKey | null =
    failure === null
      ? null
      : failure === "conflict"
        ? "center.addConflict"
        : failure === "not_found"
          ? "center.addGone"
          : failure === "forbidden"
            ? "apps.addRefused"
            : "apps.addFailed";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="text-fg-2">{t("center.addCopyBody")}</p>
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("center.addCopyWhere")}</legend>
          {places.map((space) => {
            const copy = copyIn(space);
            const own = space.kind === "personal";
            const label = own ? t("nav.personal") : space.name;
            return (
              <div key={space.id} className="flex min-w-0 items-center gap-2">
                <label className={`${CHOICE} flex-1 ${copy ? "cursor-default opacity-70" : ""}`}>
                  <input
                    type="radio"
                    name={`${name}-space`}
                    value={space.id}
                    className={RADIO}
                    disabled={copy !== undefined}
                    checked={chosen?.id === space.id}
                    onChange={() => setChosenId(space.id)}
                  />
                  {own ? (
                    <UserRound size={16} aria-hidden="true" className="flex-none text-fg-2" />
                  ) : (
                    <Users size={16} aria-hidden="true" className="flex-none text-fg-2" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="clip font-medium">{label}</span>
                    <span className="text-xs text-fg-3">{copy ? t("center.hasCopy") : own ? t("apps.onlyYou") : t("apps.shared")}</span>
                  </span>
                </label>
                {copy ? (
                  <Link
                    to={appPath(copy)}
                    className={buttonClass({ size: "sm", className: "flex-none" })}
                    aria-label={own ? t("center.openCopyPersonal") : t("center.openCopyIn", { space: space.name })}
                  >
                    {t("center.open")}
                  </Link>
                ) : null}
              </div>
            );
          })}
        </fieldset>
        {group.canAddApps ? null : <p className="text-xs text-fg-3">{t("center.groupNotAddable", { group: group.name })}</p>}
        {inGroup ? <WhoCanUse name={name} value={memberAccess} onChange={setMemberAccess} /> : null}
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={add.isPending || !chosen}>
            {t("apps.addConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}

/** Says where the copy went, and takes the focus: "Open" it, or change it in the chat. */
function Added({ added, app, onClose }: { added: AddCopyResult & { space: Space }; app: string; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const { space, appId, restored } = added;
  const said =
    space.kind === "personal"
      ? t(restored ? "center.restoredPersonal" : "center.addedPersonal", { app })
      : t(restored ? "center.restoredIn" : "center.addedIn", { app, space: space.name });
  const chat = `/chat?${new URLSearchParams({ space: space.id, app: appId }).toString()}`;
  return (
    <DialogBody>
      <p ref={ref} role="status" tabIndex={-1} className="rounded-ctl font-medium">
        {said}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onClose}>{t("center.close")}</Button>
        <Link to={chat} className={buttonClass({})}>
          {t("center.changeInChat")}
        </Link>
        <Link to={appPath({ id: appId, spaceId: space.id })} className={buttonClass({ variant: "primary" })}>
          {t("center.open")}
        </Link>
      </div>
    </DialogBody>
  );
}
