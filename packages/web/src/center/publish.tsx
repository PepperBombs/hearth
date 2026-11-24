/**
 * Publishing an app to a group (docs/center.md, "Pages"), from its page:
 * "Publish…" in the top bar, for an owner of the app's space who is in a
 * group, opens a dialog that reads `GET .../publish` afresh and shows
 *
 * - where the app is published already, each with "Publish again" and,
 *   where the person may, "Unpublish";
 * - exactly what would leave: the name and description, the collections and
 *   their fields, the settings with their defaults, the instructions for the
 *   model in full and the page's size; what never leaves; and that the
 *   group's members see who published it;
 * - the problems that refuse it, worded here from their codes, each with
 *   what to ask the chat to change;
 * - the group, a note, and the tick without which Publish stays off.
 *
 * Whether it may be published is the server's to say: the dialog only
 * draws what the review lists, and reads it again after every answer.
 */
import type { Setting } from "@hearth/sdk";
import type { AppSummary, Locale, PublishProblem, PublishReview } from "@hearth/shared";
import { MAX_LISTINGS_PER_GROUP, MAX_PUBLISH_NOTE } from "@hearth/shared";
import { RefreshCw, Upload, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Checkbox, Dialog, DialogBody, Field, IconButton, Input, Row, Rows } from "@hearth/sdk/web";
import { CHOICE, RADIO } from "../apps/add-parts";
import { AppIcon } from "../components/app-icon";
import { LinkedText } from "../components/linked-text";
import { joinNames, pickLocalized, type PlainMessageKey, type Translate } from "../i18n";
import { formatDay } from "../lib/date";
import { useToday } from "../lib/use-today";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { useSession } from "../session/session";
import { publishReviewKey, usePublish, usePublishReview, useUnpublish } from "./api";

/** The dialog is wider than most: it shows the instructions in full. */
const LAYOUT = "m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[560px] rounded-card border";

/**
 * "Publish…" in an app's top bar. Publishing is for an owner of the app's
 * space (the server's `publishableApp` says so too), and goes to a group,
 * so someone in none is not offered it.
 */
export function PublishButton({ app }: { app: AppSummary }) {
  const session = useSession();
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);
  const inAGroup = session.spaces.some((candidate) => candidate.kind === "group");
  if (space?.role !== "owner" || !inAGroup) return null;
  const name = pickLocalized(app.name, locale);
  const title = t("publish.title", { app: name });
  return (
    <>
      <IconButton label={t("publish.open", { app: name })} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Upload size={16} aria-hidden="true" />
      </IconButton>
      <Dialog open={open} onClose={() => setOpen(false)} label={title} layoutClassName={LAYOUT}>
        <PublishForm app={app} title={title} onClose={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

/** What was just done, said at the top of the dialog in a line that takes the focus. */
type Done = { kind: "published"; group: string; revision: number } | { kind: "unpublished"; group: string };

/** Mounted each time the dialog opens, so that it reads the review afresh and starts unticked. */
function PublishForm({ app, title, onClose }: { app: AppSummary; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const review = usePublishReview(app.spaceId, app.id);
  const [done, setDone] = useState<Done | null>(null);

  if (done?.kind === "published") return <Published done={done} onClose={onClose} />;

  let body;
  if (review.isPending) {
    body = (
      <p role="status" className="text-xs text-fg-3">
        {t("publish.loading")}
      </p>
    );
  } else if (review.isError) {
    const failure = failureCode(review.error);
    body =
      failure === "forbidden" || failure === "not_found" ? (
        <p role="alert" className="text-xs text-down">
          {t(failure === "forbidden" ? "publish.forbidden" : "publish.gone")}
        </p>
      ) : (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-down">{t("publish.loadFailed")}</p>
          <Button size="sm" onClick={() => void review.refetch()}>
            <RefreshCw size={14} aria-hidden="true" />
            {t("apps.retry")}
          </Button>
        </div>
      );
  } else {
    return <Review app={app} title={title} review={review.data} done={done} onDone={setDone} onClose={onClose} />;
  }
  return (
    <DialogBody>
      <h2 className="text-md font-semibold">{title}</h2>
      {body}
      <div className="flex justify-end">
        <Button onClick={onClose}>{t("center.close")}</Button>
      </div>
    </DialogBody>
  );
}

/** The problems that refuse the app wherever it goes: all of them but "too_many", which closes one group. */
function blocking(problems: readonly PublishProblem[]): PublishProblem[] {
  return problems.filter((problem) => problem.code !== "too_many");
}

/** The first group the app may go to: one it is not published to yet, else one it may be published to again. */
function firstChoice(review: PublishReview): string {
  const full = new Set(review.problems.filter((problem) => problem.code === "too_many").map((problem) => problem.spaceId));
  const open = review.groups.filter((group) => !full.has(group.id));
  const unpublished = open.find((group) => !review.listings.some((listing) => listing.spaceId === group.id));
  return (unpublished ?? open[0])?.id ?? "";
}

function Review(props: {
  app: AppSummary;
  title: string;
  review: PublishReview;
  done: Done | null;
  onDone: (done: Done) => void;
  onClose: () => void;
}) {
  const { app, title, review, done, onDone, onClose } = props;
  const { t } = useI18n();
  const name = useId();
  // "Publish again" chooses its group and takes the person to the note.
  const noteRef = useRef<HTMLDivElement>(null);
  const publish = usePublish(app.spaceId, app.id);
  const [chosenId, setChosenId] = useState(() => firstChoice(review));
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);

  const full = new Set(review.problems.filter((problem) => problem.code === "too_many").map((problem) => problem.spaceId));
  const refusing = blocking(review.problems);
  // The review is read again after every answer: a group that is gone or full is no longer chosen.
  const open = (id: string) => review.groups.find((group) => group.id === id && !full.has(group.id));
  const chosen = open(chosenId) ?? open(firstChoice(review));
  const again = chosen !== undefined && review.listings.some((listing) => listing.spaceId === chosen.id);
  const groupName = (spaceId: string) => review.groups.find((group) => group.id === spaceId)?.name ?? "";

  const publishAgain = (spaceId: string) => {
    setChosenId(spaceId);
    noteRef.current?.querySelector("input")?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !checked || refusing.length > 0 || publish.isPending) return;
    publish.mutateAsync({ to: chosen.id, note: note.trim() }).then(
      (result) =>
        onDone({
          kind: "published",
          group: chosen.name,
          revision: result.revision,
        }),
      // The dialog shows the failure, and the review read again shows why.
      () => undefined,
    );
  };

  const failure = publish.error ? failureCode(publish.error) : null;
  const problem: PlainMessageKey | null =
    failure === null
      ? null
      : failure === "invalid_request"
        ? "publish.refusedNow"
        : failure === "conflict"
          ? "publish.fullNow"
          : failure === "forbidden"
            ? "publish.forbidden"
            : failure === "not_found"
              ? "publish.gone"
              : "publish.failed";

  if (review.groups.length === 0) {
    return (
      <DialogBody>
        <h2 className="text-md font-semibold">{title}</h2>
        <p className="text-fg-2">{t("publish.noGroups")}</p>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t("center.close")}</Button>
        </div>
      </DialogBody>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        {done?.kind === "unpublished" ? <DoneLine key={done.group} text={t("publish.unpublished", { group: done.group })} /> : null}
        <p className="text-fg-2">{t("publish.intro")}</p>
        {review.listings.length > 0 ? (
          <Listings review={review} app={app} groupName={groupName} onPublishAgain={publishAgain} onUnpublished={onDone} />
        ) : null}
        <WhatLeaves review={review} />
        <p className="text-xs text-fg-2">{t("publish.neverLeaves")}</p>
        <p className="text-xs text-fg-2">{t("publish.yourName")}</p>
        {refusing.length > 0 ? <Problems problems={refusing} /> : null}
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("publish.to")}</legend>
          {review.groups.map((group) => {
            const listing = review.listings.find((entry) => entry.spaceId === group.id);
            const isFull = full.has(group.id);
            return (
              <label key={group.id} className={`${CHOICE} ${isFull ? "cursor-default opacity-70" : ""}`}>
                <input
                  type="radio"
                  name={`${name}-group`}
                  value={group.id}
                  className={RADIO}
                  disabled={isFull}
                  checked={chosen?.id === group.id}
                  onChange={() => setChosenId(group.id)}
                />
                <Users size={16} aria-hidden="true" className="flex-none text-fg-2" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="clip font-medium">{group.name}</span>
                  <span className="text-xs text-fg-3">
                    {isFull
                      ? t("publish.groupFull", { max: MAX_LISTINGS_PER_GROUP })
                      : listing
                        ? t("publish.publishedAt", {
                            revision: listing.revision,
                          })
                        : t("publish.notYet")}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div ref={noteRef} className="flex min-w-0 flex-col">
          <Field
            label={again ? t("publish.noteAgain") : t("publish.note")}
            hint={t("publish.noteHint", { max: MAX_PUBLISH_NOTE })}
            className="items-stretch"
          >
            {({ id, hintId }) => (
              <Input
                id={id}
                aria-describedby={hintId}
                value={note}
                maxLength={MAX_PUBLISH_NOTE}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            )}
          </Field>
        </div>
        <Checkbox checked={checked} onChange={setChecked}>
          {t("publish.tick")}
        </Checkbox>
        {problem ? (
          <p role="status" className="text-xs text-down">
            {t(problem)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("apps.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!checked || !chosen || refusing.length > 0 || publish.isPending}>
            {again ? t("publish.again") : t("publish.confirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}

/** A line that says what was just done, and takes the focus. */
function DoneLine({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p ref={ref} role="status" tabIndex={-1} className="rounded-ctl font-medium">
      {text}
    </p>
  );
}

/** Says where the app went, and that its members find it in the app center. */
function Published({ done, onClose }: { done: Extract<Done, { kind: "published" }>; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <DialogBody>
      <DoneLine
        text={t("publish.published", {
          group: done.group,
          revision: done.revision,
        })}
      />
      <p className="text-fg-2">
        <LinkedText text={t("publish.publishedNote")} to="/center" />
      </p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={onClose}>
          {t("center.close")}
        </Button>
      </div>
    </DialogBody>
  );
}

/** Where the app is published among the person's groups: "Publish again", and "Unpublish" for those who may. */
function Listings(props: {
  review: PublishReview;
  app: AppSummary;
  groupName: (spaceId: string) => string;
  onPublishAgain: (spaceId: string) => void;
  onUnpublished: (done: Done) => void;
}) {
  const { review, app, groupName, onPublishAgain, onUnpublished } = props;
  const { locale, t } = useI18n();
  const today = useToday();
  const unpublish = useUnpublish(publishReviewKey(app.spaceId, app.id));
  const [asking, setAsking] = useState<string | null>(null);
  const appName = pickLocalized(app.name, locale);

  const confirm = (id: string, group: string) => {
    if (unpublish.isPending) return;
    const done = () => {
      setAsking(null);
      onUnpublished({ kind: "unpublished", group });
    };
    // Someone else may have unpublished it first: it is gone all the same.
    unpublish.mutateAsync(id).then(done, (error: unknown) => {
      if (failureCode(error) === "not_found") done();
    });
  };
  const failed = unpublish.error && failureCode(unpublish.error) !== "not_found";

  return (
    <section aria-label={t("publish.where")} className="flex min-w-0 flex-col gap-1">
      <h3 className="text-xs font-medium text-fg-3">{t("publish.where")}</h3>
      <Rows>
        {review.listings.map((listing) => {
          const group = groupName(listing.spaceId);
          const when = formatDay(new Date(listing.updatedAt), today, locale);
          const revision =
            listing.note === ""
              ? t("center.revision", { revision: listing.revision })
              : t("center.revisionNote", {
                  revision: listing.revision,
                  note: listing.note,
                });
          return (
            <Row key={listing.id} className="flex-wrap" data-listing={listing.id}>
              <span className="flex min-w-0 flex-1 basis-[10rem] flex-col">
                <span className="clip font-medium">{group}</span>
                <span className="text-xs text-fg-3">{t("publish.revisionOn", { revision, when })}</span>
              </span>
              {asking === listing.id ? (
                <span className="flex min-w-0 basis-full flex-col gap-1.5">
                  <span className="text-xs text-fg-2">{t("center.unpublishBody", { group })}</span>
                  {failed ? (
                    <span role="status" className="text-xs text-down">
                      {t(failureCode(unpublish.error) === "forbidden" ? "center.unpublishRefused" : "center.unpublishFailed")}
                    </span>
                  ) : null}
                  <span className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        unpublish.reset();
                        setAsking(null);
                      }}
                    >
                      {t("apps.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={unpublish.isPending}
                      aria-label={t("center.unpublishApp", {
                        app: appName,
                        group,
                      })}
                      onClick={() => confirm(listing.id, group)}
                    >
                      {t("center.unpublish")}
                    </Button>
                  </span>
                </span>
              ) : (
                <span className="ml-auto flex flex-none flex-wrap justify-end gap-2">
                  <Button size="sm" aria-label={t("publish.againIn", { group })} onClick={() => onPublishAgain(listing.spaceId)}>
                    {t("publish.again")}
                  </Button>
                  {listing.canUnpublish ? (
                    <Button
                      size="sm"
                      aria-label={t("center.unpublishApp", {
                        app: appName,
                        group,
                      })}
                      onClick={() => {
                        unpublish.reset();
                        setAsking(listing.id);
                      }}
                    >
                      {t("center.unpublish")}
                    </Button>
                  ) : null}
                </span>
              )}
            </Row>
          );
        })}
      </Rows>
    </section>
  );
}

/** Exactly what would leave: the manifest as the review gives it, and the page's size. */
function WhatLeaves({ review }: { review: PublishReview }) {
  const { locale, t } = useI18n();
  const { app } = review;
  const settings = Object.entries(app.settings as Record<string, Setting>);
  return (
    <section aria-label={t("publish.leaves")} className="flex min-w-0 flex-col gap-2 rounded-ctl border border-line p-2.5">
      <h3 className="text-xs font-medium text-fg-3">{t("publish.leaves")}</h3>
      <div className="flex min-w-0 items-start gap-2.5">
        <AppIcon icon={app.icon} color={app.color} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium wrap-anywhere">{both(app.name, locale)}</span>
          <span className="text-xs text-fg-2 wrap-anywhere">{both(app.description, locale)}</span>
        </span>
      </div>
      <Part label={t("publish.collections")}>
        {app.collections.length === 0 ? (
          t("center.keepsNothing")
        ) : (
          <ul className="flex flex-col">
            {app.collections.map((collection) => (
              <li key={collection.name} className="wrap-anywhere">
                {collection.fields.length === 0 ? collection.name : `${collection.name}: ${joinNames(collection.fields, locale)}`}
              </li>
            ))}
          </ul>
        )}
      </Part>
      <Part label={t("publish.settings")}>
        {settings.length === 0 ? (
          t("publish.noSettings")
        ) : (
          <ul className="flex flex-col">
            {settings.map(([key, setting]) => (
              <li key={key} className="wrap-anywhere">
                {pickLocalized(setting.label, locale)}
                {COLON[locale]}
                {defaultText(setting, locale, t)}
              </li>
            ))}
          </ul>
        )}
      </Part>
      <Part label={t("publish.instructions")}>
        {app.instructions.trim() === "" ? (
          t("publish.noInstructions")
        ) : (
          <pre className="max-h-60 overflow-auto rounded-ctl bg-surface-2 p-2 font-[inherit] whitespace-pre-wrap wrap-anywhere">
            {app.instructions}
          </pre>
        )}
      </Part>
      <Part label={t("publish.page")}>{t("publish.pageSize", { size: kilobytes(app.pageBytes, locale) })}</Part>
    </section>
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-xs">
      <span className="font-medium text-fg-3">{label}</span>
      <div className="min-w-0 text-fg-2">{children}</div>
    </div>
  );
}

/** A text in both languages, as it leaves: once when they are the same, "Ledger / 账本" when they differ, the reader's first. */
function both(text: { en: string; zh: string }, locale: Locale): string {
  const first = pickLocalized(text, locale);
  const other = locale === "en" ? text.zh : text.en;
  return other === "" || other === first ? first : `${first} / ${other}`;
}

/**
 * What comes between a setting and its default, as each language writes it:
 * punctuation alone, so kept here and not in the dictionaries, where every
 * Chinese string holds Chinese text.
 */
const COLON: Readonly<Record<Locale, string>> = { en: ": ", zh: "：" };

/** A page's size in kB, at least 0.1. */
function kilobytes(bytes: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 1,
  }).format(Math.max(0.1, bytes / 1000));
}

/** A setting's default, as the settings dialog would show it. */
function defaultText(setting: Setting, locale: Locale, t: Translate): string {
  switch (setting.type) {
    case "switch":
      return setting.default ? t("publish.on") : t("publish.off");
    case "number":
      return String(setting.default);
    case "select":
      return setting.options[setting.default] ? pickLocalized(setting.options[setting.default]!, locale) : setting.default;
    case "multi-select":
      return setting.default.length === 0
        ? t("publish.empty")
        : joinNames(
            setting.default.map((key) => (setting.options[key] ? pickLocalized(setting.options[key]!, locale) : key)),
            locale,
          );
    case "list":
      return setting.default.length === 0 ? t("publish.empty") : joinNames(setting.default, locale);
    default:
      return setting.default === "" ? t("publish.empty") : setting.default;
  }
}

/** The problems that refuse it, each worded with what to ask the chat to change. */
function Problems({ problems }: { problems: PublishProblem[] }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex min-w-0 flex-col gap-1.5 rounded-ctl border border-down p-2.5">
      <p className="text-xs font-medium text-down">{t("publish.problems")}</p>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-fg-2">
        {problems.map((problem, index) => (
          <li key={index} className="wrap-anywhere">
            {problemText(problem, t)}
            {problem.code === "invalid" && problem.detail ? (
              // The checker's own words, in English, as the chat shows them.
              <span lang="en" className="block text-fg-3">
                {problem.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PLACES: Record<NonNullable<PublishProblem["where"]>["part"], PlainMessageKey> = {
  name: "publish.inName",
  description: "publish.inDescription",
  instructions: "publish.inInstructions",
  collections: "publish.inCollections",
  settings: "publish.inSettings",
  page: "publish.inPage",
};

function problemText(problem: PublishProblem, t: Translate): string {
  switch (problem.code) {
    case "invalid":
      return t("publish.problemInvalid");
    case "network":
      return t("publish.problemNetwork");
    case "unchanged_copy":
      return t("publish.problemUnchanged");
    case "email": {
      const where = problem.where;
      const place = !where
        ? t("publish.inApp")
        : where.part === "page" && where.line
          ? t("publish.inPageLine", { line: where.line })
          : t(PLACES[where.part]);
      return t("publish.problemEmail", { place });
    }
    case "too_many":
      return t("publish.groupFull", { max: MAX_LISTINGS_PER_GROUP });
  }
}
