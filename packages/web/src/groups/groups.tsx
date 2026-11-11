/**
 * Groups in Settings: a card for each group the person is in, and one that
 * explains groups and, for whoever the server lets (the session's
 * `canCreateGroups`; owner's decision 4), creates one
 * (docs/mini-app-contract.md, sections A6 and A8, build step 10).
 *
 * A group's card shows its people to everyone in it. Its owners also rename
 * it, add people and manage them (./people.tsx), and decide who can use
 * each app (./access-table.tsx). Anyone may leave a group; its last owner
 * cannot, so that a group always keeps one (owner's decision 3).
 */
import { createSpaceRequestSchema, spacePatchSchema, type Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, Field, Input } from "@hearth/sdk/web";
import { LogOut, Plus, RefreshCw, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Card, CardFooter, CardHeader } from "../components/card";
import { LinkedText } from "../components/linked-text";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { useSession } from "../session/session";
import { AccessTable } from "./access-table";
import { createGroup, removeMember, renameGroup } from "./api";
import { People } from "./people";
import { useGroupChange, useSpaceApps } from "./queries";

export function GroupsSection() {
  const session = useSession();
  const groups = session.spaces.filter((space) => space.kind === "group");
  return (
    <>
      {groups.map((space) => (
        <GroupCard key={space.id} space={space} />
      ))}
      {session.canCreateGroups || groups.length === 0 ? <GroupsCard canCreate={session.canCreateGroups} /> : null}
    </>
  );
}

/** What a group is, and for those the server lets, the button that creates one. */
function GroupsCard({ canCreate }: { canCreate: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Card aria-label={t("groups.title")}>
      <CardHeader icon={<Users size={16} aria-hidden="true" />} title={t("groups.title")} />
      <p className="text-fg-2">{canCreate ? t("groups.intro") : t("groups.introNone")}</p>
      {canCreate ? (
        <CardFooter className="flex flex-col items-start gap-2">
          {created ? (
            <p role="status" className="text-xs text-fg-2">
              {t("groups.created", { group: created })}
            </p>
          ) : null}
          <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            {t("groups.create")}
          </Button>
          <Dialog open={open} onClose={() => setOpen(false)} label={t("groups.create")}>
            <CreateGroupForm onClose={() => setOpen(false)} onCreated={(space) => setCreated(space.name)} />
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

function GroupCard({ space }: { space: Space }) {
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
        <LeaveGroup space={space} />
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

/** Leaving, after asking. The group's last owner is told to make someone else an owner first. */
function LeaveGroup({ space }: { space: Space }) {
  const { t } = useI18n();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const leave = useGroupChange(space.id, () => removeMember(space.id, session.user.id));
  const title = t("groups.leaveTitle", { group: space.name });
  const close = () => {
    leave.reset();
    setOpen(false);
  };
  const problem = leave.error ? (failureCode(leave.error) === "conflict" ? t("groups.lastOwner") : t("groups.leaveFailed")) : null;

  return (
    <div className="flex border-t border-line pt-4">
      <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <LogOut size={14} aria-hidden="true" />
        {t("groups.leave")}
      </Button>
      <Dialog open={open} onClose={close} label={title}>
        <DialogBody>
          <h2 className="text-md font-semibold">{title}</h2>
          <p className="text-fg-2">{t("groups.leaveBody")}</p>
          {problem ? (
            <p role="status" className="text-xs text-down">
              {problem}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t("groups.cancel")}</Button>
            <Button variant="primary" disabled={leave.isPending} onClick={() => leave.mutate(undefined, { onSuccess: close })}>
              {t("groups.leaveConfirm")}
            </Button>
          </div>
        </DialogBody>
      </Dialog>
    </div>
  );
}
