/**
 * The people of a group, in its card in Settings: everyone in it, by name
 * and role, and for its owners also each person's address, who may add
 * apps, the invitations still waiting, adding someone, and a dialog per
 * person to change their role or right to add apps or to remove them
 * (docs/mini-app-contract.md, section A6 "Groups and members", and the
 * owner's decision 3).
 *
 * Someone on the server is added at once; anyone else is invited, if the
 * server lets this person invite (`canInvitePeople` in the session), and
 * joins when they first open Hearth.
 */
import type { MemberPatch, Space, SpaceApps, SpaceInvitation, SpaceMember, SpaceMemberDetail, SpaceRole } from "@hearth/shared";
import { Button, Dialog, DialogBody, Field, IconButton, Input, Row, Rows, Segmented, Switch, Tag } from "@hearth/sdk/web";
import { Mail, UserCog, UserPlus, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Avatar } from "../components/avatar";
import { CardFooter } from "../components/card";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { useSession } from "../session/session";
import { addMember, changeMember, removeMember, withdrawInvitation } from "./api";
import { useGroupChange } from "./queries";

/** What happened to the last address an owner added, to say so under the list. */
export type Added = { email: string; outcome: "added" | "invited" };

export function People({ space, list }: { space: Space; list: SpaceApps | undefined }) {
  const { t } = useI18n();
  const session = useSession();
  const owner = space.role === "owner";
  const [managing, setManaging] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const withdraw = useGroupChange(space.id, (email: string) => withdrawInvitation(space.id, email));
  const detailOf = (id: string) => list?.members.find((member) => member.id === id);
  // The person whose dialog is open, while they are in the group and this person owns it.
  const managed = owner ? space.members.find((member) => member.id === managing) : undefined;
  // When either stops, whoever made the change, the dialog is gone for good: it must not open
  // again by itself if they come back, added again or made an owner again. Removing someone
  // cannot close it itself: the session that no longer lists them can take the dialog away first.
  if (managing !== null && managed === undefined) setManaging(null);
  // Likewise the dialog that adds someone, which is an owner's.
  if (adding && !owner) setAdding(false);

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-medium">{t("groups.people")}</h3>
      <Rows aria-label={t("groups.people")}>
        {space.members.map((member) => (
          <PersonRow
            key={member.id}
            member={member}
            detail={detailOf(member.id)}
            isYou={member.id === session.user.id}
            onManage={owner ? () => setManaging(member.id) : undefined}
          />
        ))}
        {owner
          ? (list?.invitations ?? []).map((invitation) => (
              <InvitationRow
                key={invitation.email}
                invitation={invitation}
                pending={withdraw.isPending && withdraw.variables === invitation.email}
                onWithdraw={() => withdraw.mutate(invitation.email)}
              />
            ))
          : null}
      </Rows>
      {withdraw.isError ? (
        <p role="status" className="text-xs text-down">
          {t("groups.withdrawFailed")}
        </p>
      ) : null}
      {owner ? (
        <CardFooter className="flex flex-col items-start gap-2">
          {added ? (
            <p role="status" className="text-xs text-fg-2">
              {added.outcome === "added" ? t("groups.added", { email: added.email }) : t("groups.invitedNote", { email: added.email })}
            </p>
          ) : null}
          <Button size="sm" aria-haspopup="dialog" onClick={() => setAdding(true)}>
            <UserPlus size={14} aria-hidden="true" />
            {t("groups.add")}
          </Button>
        </CardFooter>
      ) : null}
      {owner ? <AddPersonDialog space={space} open={adding} onClose={() => setAdding(false)} onAdded={setAdded} /> : null}
      {managed ? (
        <ManageDialog
          space={space}
          member={managed}
          detail={detailOf(managed.id)}
          isYou={managed.id === session.user.id}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </div>
  );
}

function PersonRow(props: { member: SpaceMember; detail: SpaceMemberDetail | undefined; isYou: boolean; onManage?: () => void }) {
  const { member, detail, isYou, onManage } = props;
  const { t } = useI18n();
  return (
    <Row data-person={member.id}>
      <Avatar name={member.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{isYou ? t("groups.you", { name: member.name }) : member.name}</span>
        {detail ? <span className="text-xs break-all text-fg-3">{detail.email}</span> : null}
      </span>
      <span className="flex flex-none flex-wrap items-center justify-end gap-1">
        {member.role === "owner" ? <Tag>{t("groups.owner")}</Tag> : null}
        {member.role === "member" && detail?.canAddApps ? <Tag>{t("groups.canAddApps")}</Tag> : null}
      </span>
      {onManage ? (
        <IconButton label={t("groups.manage", { name: member.name })} aria-haspopup="dialog" onClick={onManage}>
          <UserCog size={16} aria-hidden="true" />
        </IconButton>
      ) : null}
    </Row>
  );
}

function InvitationRow(props: { invitation: SpaceInvitation; pending: boolean; onWithdraw: () => void }) {
  const { invitation, pending, onWithdraw } = props;
  const { t } = useI18n();
  return (
    <Row data-invitation={invitation.email}>
      <span className="inline-flex size-7 flex-none items-center justify-center rounded-full bg-surface-2 text-fg-3">
        <Mail size={14} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 break-all">{invitation.email}</span>
      <span className="flex flex-none flex-wrap items-center justify-end gap-1">
        <Tag>{t("groups.invited")}</Tag>
        {invitation.role === "owner" ? <Tag>{t("groups.owner")}</Tag> : null}
        {invitation.role === "member" && invitation.canAddApps ? <Tag>{t("groups.canAddApps")}</Tag> : null}
      </span>
      <IconButton label={t("groups.withdraw", { email: invitation.email })} disabled={pending} onClick={onWithdraw}>
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Row>
  );
}

function AddPersonDialog(props: { space: Space; open: boolean; onClose: () => void; onAdded: (added: Added) => void }) {
  const { t } = useI18n();
  const title = t("groups.addTitle", { group: props.space.name });
  return (
    <Dialog open={props.open} onClose={props.onClose} label={title}>
      <AddPersonForm {...props} title={title} />
    </Dialog>
  );
}

/** Mounted each time the dialog opens, so that it starts empty, as a plain member. */
function AddPersonForm({ space, onClose, onAdded, title }: { space: Space; onClose: () => void; onAdded: (added: Added) => void; title: string }) {
  const { t } = useI18n();
  const session = useSession();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SpaceRole>("member");
  const [canAddApps, setCanAddApps] = useState(false);
  const add = useGroupChange(space.id, () =>
    addMember(space.id, { email: email.trim(), role, canAddApps: role === "member" ? canAddApps : undefined }),
  );
  const switchLabel = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (add.isPending || email.trim() === "") return;
    add.mutate(undefined, {
      onSuccess: ({ outcome }) => {
        onAdded({ email: email.trim(), outcome });
        onClose();
      },
    });
  };

  const failure = add.error ? failureCode(add.error) : null;
  const problem =
    failure === "invalid_request"
      ? t("groups.addInvalid")
      : failure === "conflict"
        ? t("groups.addTaken")
        : failure === "forbidden"
          ? t("groups.addRefused")
          : failure
            ? t("groups.addFailed")
            : null;

  return (
    // The browser's own check of the address would speak the browser's language; the server's answer is translated.
    <form onSubmit={submit} noValidate className="flex max-h-[calc(100dvh-34px)] flex-col">
      <DialogBody className="min-h-0 overflow-y-auto">
        <h2 className="text-md font-semibold">{title}</h2>
        <Field label={t("groups.addEmail")} hint={t("groups.addEmailHint")} className="items-stretch">
          {({ id, hintId }) => (
            <Input
              id={id}
              aria-describedby={hintId}
              aria-invalid={failure === "invalid_request" || undefined}
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label={t("groups.role")} hint={t("groups.roleHint")}>
          <Segmented<SpaceRole>
            label={t("groups.role")}
            value={role}
            onChange={setRole}
            options={[
              { value: "member", label: t("groups.roleMember") },
              { value: "owner", label: t("groups.roleOwner") },
            ]}
          />
        </Field>
        {role === "member" ? (
          <div className="flex items-center gap-3">
            <Switch aria-labelledby={switchLabel} checked={canAddApps} onCheckedChange={setCanAddApps} />
            <span id={switchLabel}>{t("groups.canAddApps")}</span>
          </div>
        ) : null}
        <p className="text-xs text-fg-3">{session.canInvitePeople ? t("groups.addInviteHint") : t("groups.addExistingOnly")}</p>
        {problem ? (
          <p role="status" className="text-xs text-down">
            {problem}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("groups.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={add.isPending || email.trim() === ""}>
            {t("groups.addConfirm")}
          </Button>
        </div>
      </DialogBody>
    </form>
  );
}

/**
 * An owner's controls for one person in the group: their role and whether
 * they may add apps, each saved at once, and removing them. For the owner
 * themselves there is no "remove": leaving is at the foot of the card.
 */
function ManageDialog(props: { space: Space; member: SpaceMember; detail: SpaceMemberDetail | undefined; isYou: boolean; onClose: () => void }) {
  const { space, member, detail, isYou, onClose } = props;
  const { t } = useI18n();
  const switchLabel = useId();
  const [confirming, setConfirming] = useState(false);
  const change = useGroupChange(space.id, (patch: MemberPatch) => changeMember(space.id, member.id, patch));
  const remove = useGroupChange(space.id, () => removeMember(space.id, member.id));
  const title = t("groups.manageTitle", { name: member.name, group: space.name });
  const busy = change.isPending || remove.isPending;
  const owner = member.role === "owner";

  const close = () => {
    change.reset();
    remove.reset();
    onClose();
  };

  const changeProblem = change.error ? (failureCode(change.error) === "conflict" ? t("groups.lastOwner") : t("groups.changeFailed")) : null;
  const removeProblem = remove.error
    ? failureCode(remove.error) === "conflict"
      ? t("groups.lastOwner")
      : t("groups.removeFailed", { name: member.name })
    : null;

  return (
    <Dialog open onClose={close} label={confirming ? t("groups.removeTitle", { name: member.name, group: space.name }) : title}>
      {confirming ? (
        <DialogBody>
          <h2 className="text-md font-semibold">{t("groups.removeTitle", { name: member.name, group: space.name })}</h2>
          <p className="text-fg-2">{t("groups.removeBody")}</p>
          {removeProblem ? (
            <p role="status" className="text-xs text-down">
              {removeProblem}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>{t("groups.cancel")}</Button>
            <Button variant="primary" disabled={busy} onClick={() => remove.mutate(undefined, { onSuccess: close })}>
              {t("groups.removeConfirm")}
            </Button>
          </div>
        </DialogBody>
      ) : (
        <DialogBody>
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={member.name} size="lg" />
            <div className="flex min-w-0 flex-col">
              <h2 className="text-md font-semibold">{title}</h2>
              {detail ? <span className="text-xs break-all text-fg-3">{detail.email}</span> : null}
            </div>
          </div>
          <Field label={t("groups.role")} hint={t("groups.roleHint")}>
            <Segmented<SpaceRole>
              label={t("groups.role")}
              value={member.role}
              onChange={(role) => {
                if (!busy && role !== member.role) change.mutate({ role });
              }}
              options={[
                { value: "member", label: t("groups.roleMember") },
                { value: "owner", label: t("groups.roleOwner") },
              ]}
            />
          </Field>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <Switch
                aria-labelledby={switchLabel}
                checked={owner || detail?.canAddApps === true}
                disabled={owner || busy || !detail}
                onCheckedChange={(canAddApps) => change.mutate({ canAddApps })}
              />
              <span id={switchLabel}>{t("groups.canAddApps")}</span>
            </div>
            {owner ? <span className="text-xs text-fg-3">{t("groups.canAddAppsHint")}</span> : null}
          </div>
          {changeProblem ? (
            <p role="status" className="text-xs text-down">
              {changeProblem}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {isYou ? null : (
              <Button className="mr-auto" disabled={busy} onClick={() => setConfirming(true)}>
                {t("groups.remove")}
              </Button>
            )}
            <Button variant="primary" onClick={close}>
              {t("groups.close")}
            </Button>
          </div>
        </DialogBody>
      )}
    </Dialog>
  );
}
