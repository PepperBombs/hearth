/**
 * Groups in Settings: a card for each group the person is in, and one that
 * explains groups and, for whoever the server lets (the session's
 * `canCreateGroups`; owner's decision 4), creates one
 * (docs/mini-app-contract.md, sections A6 and A8, build step 10).
 *
 * A group's card shows its people to everyone in it. Its owners also rename
 * it, add people and manage them (./people.tsx), and decide who can use
 * each app (./access-table.tsx). Anyone may leave a group; its last owner
 * cannot while others are in it, so that a group always keeps one (owner's
 * decision 3). Its only member can: leaving then deletes the group and
 * everything in it, once they have typed its name.
 */
import { createSpaceRequestSchema, spacePatchSchema, type Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, Field, Input } from "@hearth/sdk/web";
import { LogOut, Plus, RefreshCw, Users } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Card, CardFooter, CardHeader } from "../components/card";
import { LinkedText } from "../components/linked-text";
import { failureCode } from "../session/api";
import type { PlainMessageKey } from "../i18n";
import { useI18n } from "../session/preferences";
import { useSession } from "../session/session";
import { AccessTable } from "./access-table";
import { createGroup, removeMember, renameGroup } from "./api";
import { People } from "./people";
import { useGroupChange, useSpaceApps } from "./queries";

/** What the Groups card says after a group was created, or deleted by its only member leaving. */
type GroupsNotice = { kind: "created" | "deleted"; group: string };

export function GroupsSection() {
  const session = useSession();
  const groups = session.spaces.filter((space) => space.kind === "group");
  const [notice, setNotice] = useState<GroupsNotice | null>(null);
  return (
    <>
      {groups.map((space) => (
        <GroupCard key={space.id} space={space} onDeleted={() => setNotice({ kind: "deleted", group: space.name })} />
      ))}
      {session.canCreateGroups || groups.length === 0 || notice?.kind === "deleted" ? (
        <GroupsCard canCreate={session.canCreateGroups} notice={notice} onCreated={(space) => setNotice({ kind: "created", group: space.name })} />
      ) : null}
    </>
  );
}

/**
 * What a group is, and for those the server lets, the button that creates
 * one. It also says which group was just created or deleted; a deleted
 * group's card is gone with the dialog that deleted it, so the note takes
 * the focus.
 */
function GroupsCard({ canCreate, notice, onCreated }: { canCreate: boolean; notice: GroupsNotice | null; onCreated: (space: Space) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const deletedNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice?.kind === "deleted") deletedNote.current?.focus();
  }, [notice]);
  return (
    <Card aria-label={t("groups.title")}>
      <CardHeader icon={<Users size={16} aria-hidden="true" />} title={t("groups.title")} />
      <p className="text-fg-2">{canCreate ? t("groups.intro") : t("groups.introNone")}</p>
      {notice?.kind === "deleted" ? (
        <p ref={deletedNote} tabIndex={-1} role="status" className="text-xs text-fg-2 [overflow-wrap:anywhere] focus:outline-none">
          {t("groups.deleted", { group: notice.group })}
        </p>
      ) : null}
      {canCreate ? (
        <CardFooter className="flex flex-col items-start gap-2">
          {notice?.kind === "created" ? (
            <p role="status" className="text-xs text-fg-2 [overflow-wrap:anywhere]">
              {t("groups.created", { group: notice.group })}
            </p>
          ) : null}
          <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            {t("groups.create")}
          </Button>
          <Dialog open={open} onClose={() => setOpen(false)} label={t("groups.create")}>
            <CreateGroupForm onClose={() => setOpen(false)} onCreated={onCreated} />
          </Dialog>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Mounted each time the dialog opens, so that it starts empty. */
function CreateGroupForm({ onClose, onCreated }: { onClose: () => void; onCreated: (space: Space) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const create = useGroupChange(null, (groupName: string) => createGroup(groupName));
  const parsed = createSpaceRequestSchema.safeParse({ name });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.success || create.isPending) return;
    create.mutate(parsed.data.name, {
      onSuccess: (space) => {
        onCreated(space);
        onClose();
      },
    });
  };

  const failure = create.error ? failureCode(create.error) : null;
  return (
    <form onSubmit={submit}>
      <DialogBody>
        <h2 className="text-md font-semibold">{t("groups.create")}</h2>
        <Field label={t("groups.createName")} hint={t("groups.createNameHint")} className="items-stretch">
          {({ id, hintId }) => (
            <Input id={id} aria-describedby={hintId} value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} />
          )}
        </Field>
        {failure ? (
          <p role="status" className="text-xs text-down">
            {failure === "forbidden" ? t("groups.createRefused") : t("groups.createFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("groups.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!parsed.success || create.isPending}>
            {t("groups.createConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}

function GroupCard({ space, onDeleted }: { space: Space; onDeleted: () => void }) {
  const { t } = useI18n();
  const owner = space.role === "owner";
  const list = useSpaceApps(space);
  return (
    <Card aria-label={space.name}>
      <CardHeader
        icon={<Users size={16} aria-hidden="true" />}
        title={space.name}
        aside={owner ? t("groups.youOwn") : t("groups.youAreMember")}
      />
      <div className="flex flex-col gap-4">
        {owner ? <GroupName space={space} /> : null}
        {/* Only while they own it: a cached list from before stepping down is not theirs to see any more. */}
        <People space={space} list={owner ? list.data : undefined} />
        {!owner && space.canAddApps ? (
          <p className="text-xs text-fg-2">
            <LinkedText text={t("groups.youCanAddApps")} to="/apps" />
          </p>
        ) : null}
        {owner ? (
          list.data ? (
            <AccessTable space={space} list={list.data} />
          ) : (
            <div className="flex flex-col items-start gap-2 border-t border-line pt-4" role={list.isError ? "alert" : "status"}>
              {list.isError ? (
                <>
                  <p className="text-fg-2">{t("groups.loadFailed")}</p>
                  <Button size="sm" onClick={() => void list.refetch()}>
                    <RefreshCw size={14} aria-hidden="true" />
                    {t("groups.retry")}
                  </Button>
                </>
              ) : (
                <p className="text-fg-3">{t("groups.loading")}</p>
              )}
            </div>
          )
        ) : null}
        <LeaveGroup space={space} onDeleted={onDeleted} />
      </div>
    </Card>
  );
}

type NameStatus = "idle" | "saving" | "saved" | "error" | "invalid";

/** An owner renames the group: saved when the field is left or Enter is pressed, like the person's own name. */
function GroupName({ space }: { space: Space }) {
  const { t } = useI18n();
  const [name, setName] = useState(space.name);
  const [status, setStatus] = useState<NameStatus>("idle");
  const rename = useGroupChange(space.id, (next: string) => renameGroup(space.id, next));

  // Follow the saved name when it changes underneath, as after a save or another owner's change.
  useEffect(() => setName(space.name), [space.name]);

  const commit = () => {
    const parsed = spacePatchSchema.safeParse({ name });
    if (!parsed.success || parsed.data.name === undefined) {
      setStatus("invalid");
      return;
    }
    const next = parsed.data.name;
    setName(next);
    if (next === space.name) {
      setStatus((current) => (current === "invalid" || current === "error" ? "idle" : current));
      return;
    }
    setStatus("saving");
    rename.mutate(next, { onSuccess: () => setStatus("saved"), onError: () => setStatus("error") });
  };

  const failed = status === "error" || status === "invalid";
  const statusText =
    status === "saved" ? t("groups.nameSaved") : status === "error" ? t("groups.nameError") : status === "invalid" ? t("groups.nameInvalid") : "";

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <Field label={t("groups.name")} hint={t("groups.nameHint")} className="items-stretch">
        {({ id, hintId }) => (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Input
              id={id}
              aria-describedby={hintId}
              aria-invalid={failed || undefined}
              className="max-w-[320px]"
              value={name}
              maxLength={80}
              enterKeyHint="done"
              onChange={(event) => {
                setName(event.target.value);
                setStatus("idle");
              }}
              onBlur={commit}
            />
            <span role="status" className={failed ? "text-xs text-down" : "text-xs text-fg-3"}>
              {statusText}
            </span>
          </div>
        )}
      </Field>
    </form>
  );
}

/**
 * Leaving, after asking. The group's last owner is told to make someone else
 * an owner first. Its only member may leave too, which deletes the group:
 * the dialog then says what goes and wants the group's name typed.
 *
 * The session is not loaded again on its own, so the dialog can open in the
 * wrong one of its two forms: someone joined, or everyone else left. The
 * server then refuses, the session is loaded again, and the dialog changes
 * form in place: the earlier refusal is dropped, which named a mistake the
 * person did not make, and a note says what changed.
 */
function LeaveGroup({ space, onDeleted }: { space: Space; onDeleted: () => void }) {
  const { t } = useI18n();
  const session = useSession();
  const [open, setOpen] = useState(false);
  // Whoever is alone in a group is its owner: the server keeps one.
  const alone = space.members.length === 1;
  // Once the group is deleted its owners' list answers 404: only the session is loaded again then.
  const leave = useGroupChange(alone ? null : space.id, (confirm: string | undefined) =>
    removeMember(space.id, session.user.id, confirm === undefined ? undefined : { confirm }),
  );
  const [changed, setChanged] = useState<PlainMessageKey | null>(null);
  const wasAlone = useRef(alone);
  // Before the screen is drawn, so that the refusal never shows under the other form.
  useLayoutEffect(() => {
    if (wasAlone.current === alone) return;
    wasAlone.current = alone;
    // Also detaches a request still settling, whose refusal would otherwise arrive after this.
    leave.reset();
    setChanged(open ? (alone ? "groups.nowAlone" : "groups.notAlone") : null);
    // Only a change of form counts; `leave` and `open` are read as they are then.
  }, [alone]);
  const title = alone ? t("groups.deleteTitle", { group: space.name }) : t("groups.leaveTitle", { group: space.name });
  const close = () => {
    leave.reset();
    setChanged(null);
    setOpen(false);
  };
  const leaveFailure = leave.error ? failureCode(leave.error) : null;

  return (
    <div className="flex border-t border-line pt-4">
      <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <LogOut size={14} aria-hidden="true" />
        {t("groups.leave")}
      </Button>
      <Dialog open={open} onClose={close} label={title}>
        {alone ? (
          <DeleteGroupForm space={space} title={title} leave={leave} changed={changed} onClose={close} onDeleted={onDeleted} />
        ) : (
          <DialogBody>
            <h2 className="text-md font-semibold [overflow-wrap:anywhere]">{title}</h2>
            {changed ? (
              <p role="status" className="font-medium text-fg">
                {t(changed)}
              </p>
            ) : null}
            <p className="text-fg-2">{t("groups.leaveBody")}</p>
            {leaveFailure ? (
              <p role="status" className="text-xs text-down">
                {t(
                  leaveFailure === "conflict"
                    ? "groups.lastOwner"
                    : leaveFailure === "confirm_required"
                      ? "groups.nowAlone"
                      : "groups.leaveFailed",
                )}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button onClick={close}>{t("groups.cancel")}</Button>
              <Button variant="primary" disabled={leave.isPending} onClick={() => leave.mutate(undefined, { onSuccess: close })}>
                {t("groups.leaveConfirm")}
              </Button>
            </div>
          </DialogBody>
        )}
      </Dialog>
    </div>
  );
}

type LeaveChange = ReturnType<typeof useGroupChange<string | undefined>>;

/**
 * The only member leaving, which deletes the group: says what goes with it
 * (its apps, removed ones too, with all their data; the person's
 * conversations there; its pending invitations) and that it cannot be
 * undone, and wants the group's name typed. The server checks the name again.
 * Mounted each time the dialog opens, so that the box starts empty.
 */
type DeleteGroupProps = {
  space: Space;
  title: string;
  leave: LeaveChange;
  /** Why the dialog changed to this form while open (`groups.nowAlone`), if it did. */
  changed: PlainMessageKey | null;
  onClose: () => void;
  onDeleted: () => void;
};

function DeleteGroupForm({ space, title, leave, changed, onClose, onDeleted }: DeleteGroupProps) {
  const { t } = useI18n();
  const boxId = useId();
  const list = useSpaceApps(space);
  const [typed, setTyped] = useState("");
  // How many apps go: the owners' list counts removed ones too. Until it is known, nothing is deleted.
  const apps = list.data?.apps.length;
  const invitations = space.pendingInvitations ?? 0;
  const name = space.name.trim();
  const matches = name !== "" && typed.trim() === name;
  const ready = matches && apps !== undefined && !leave.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    // Settles once the session is loaded again, which has taken the group's card, and this dialog, away.
    leave.mutateAsync(typed.trim()).then(onDeleted, () => undefined);
  };

  const failure = leave.error ? failureCode(leave.error) : null;
  const problem: PlainMessageKey | null =
    failure === null
      ? null
      : failure === "confirm_required"
        ? "groups.deleteMismatch"
        : failure === "conflict"
          ? // Sent with the name, this is refused only when someone else is in the group now.
            "groups.notAlone"
          : failure === "not_found"
            ? "groups.deleteGone"
            : "groups.deleteFailed";

  return (
    <form onSubmit={submit} className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold [overflow-wrap:anywhere]">{title}</h2>
        {changed ? (
          <p role="status" className="font-medium text-fg">
            {t(changed)}
          </p>
        ) : null}
        {apps !== undefined ? (
          <div className="flex flex-col gap-2 text-fg-2">
            <p>{t("groups.deleteIntro")}</p>
            <ul className="list-disc pl-5">
              {apps > 0 ? <li>{apps === 1 ? t("groups.deleteAppsOne") : t("groups.deleteAppsMany", { count: apps })}</li> : null}
              <li>{t("groups.deleteChats")}</li>
              {invitations > 0 ? (
                <li>{invitations === 1 ? t("groups.deleteInvitationsOne") : t("groups.deleteInvitationsMany", { count: invitations })}</li>
              ) : null}
            </ul>
            <p>{t("groups.deleteUndone")}</p>
          </div>
        ) : list.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-down">{t("groups.deleteCheckFailed")}</p>
            <Button size="sm" onClick={() => void list.refetch()}>
              <RefreshCw size={14} aria-hidden="true" />
              {t("groups.retry")}
            </Button>
          </div>
        ) : (
          <p className="text-fg-3">{t("groups.deleteCounting")}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={boxId} className="font-medium [overflow-wrap:anywhere]">
            {t("groups.deleteType", { group: name })}
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
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t("groups.cancel")}</Button>
          <Button type="submit" variant="danger" disabled={!ready}>
            {t("groups.deleteConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}
