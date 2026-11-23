/**
 * The Assistant card in Settings: what the assistant may do in each of the
 * person's spaces. The assistant is each person's own model, which they
 * save under "Your model" (`ModelCard`, src/made/model-card.tsx) and talk to
 * in the chat (docs/platform.md, "The chat").
 *
 * Each space's owners choose its level (Off, Read only, Read and change)
 * and may leave single apps out; everyone else sees what they chose. What
 * the assistant may then do for a person is worked out on the server
 * (`VISIBLE`), never here.
 */
import type { MemberAccess, Space, SpaceApps } from "@hearth/shared";
import { Button, Checkbox, Segmented } from "@hearth/sdk/web";
import { focusManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardHeader } from "../components/card";
import { LinkedText } from "../components/linked-text";
import { applied, useAppLabel, type Change } from "../groups/access-table";
import { setAppAccess, setAssistantLevel } from "../groups/api";
import { spaceAppsKey, useGroupChange, useSpaceApps } from "../groups/queries";
import type { PlainMessageKey } from "../i18n";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";

const LEVELS: readonly { value: MemberAccess; label: PlainMessageKey }[] = [
  { value: "none", label: "assistant.levelNone" },
  { value: "view", label: "assistant.levelView" },
  { value: "edit", label: "assistant.levelEdit" },
];

/** A session read less than this long ago is not read again: opening Settings as the first page asks once. */
const SESSION_FRESH_MS = 5_000;

/**
 * Reads the session again when the card comes on screen and whenever the
 * window is looked at again. The web app loads the session once, and a
 * space's level may have been changed since, by another owner, from the
 * chat or on another device: the card must not go on showing "Off" for a
 * space the assistant may now change, nor the other way round.
 */
function useSessionReadAgain(): void {
  const client = useQueryClient();
  useEffect(() => {
    const readAgain = () => {
      const readAt = client.getQueryState(SESSION_QUERY_KEY)?.dataUpdatedAt ?? 0;
      if (Date.now() - readAt < SESSION_FRESH_MS) return;
      // One reading on its way serves, as after an app's `not_found`.
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }, { cancelRefetch: false });
    };
    readAgain();
    return focusManager.subscribe((focused) => {
      if (focused) readAgain();
    });
  }, [client]);
}

/**
 * Where a failure is said. It is on the page before there is anything to
 * say: a screen reader announces text that comes into a region it already
 * knows, and often not a region that arrives with its text.
 */
function Problem({ children }: { children: string | null }) {
  return (
    <p role="status" className="text-xs text-down">
      {children ? <span className="mt-1 block">{children}</span> : null}
    </p>
  );
}

export function AssistantCard() {
  const { t } = useI18n();
  const session = useSession();
  useSessionReadAgain();

  return (
    <Card aria-label={t("assistant.title")}>
      <CardHeader icon={<ShieldCheck size={16} aria-hidden="true" />} title={t("assistant.title")} />
      <div className="flex flex-col gap-4">
        <p className="text-fg-2">
          <LinkedText text={t("assistant.intro")} to="/chat" />
        </p>

        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <div className="flex flex-col gap-0.5">
            <h3 className="font-medium">{t("assistant.spacesTitle")}</h3>
            <p className="text-xs text-fg-3">{t("assistant.youAlways")}</p>
          </div>
          {session.spaces.map((space) => (
            <SpaceLevel key={space.id} space={space} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function SpaceLevel({ space }: { space: Space }) {
  const { t } = useI18n();
  const personal = space.kind === "personal";
  const name = personal ? t("nav.personal") : space.name;
  const change = useGroupChange(space.id, (level: MemberAccess) => setAssistantLevel(space.id, level));
  // What was asked for shows at once; the session says what was saved once it is loaded again.
  const level = change.isPending ? change.variables : space.assistant;
  const levelName = t(LEVELS.find((entry) => entry.value === level)!.label);
  // Any name fits the card: a long one without a space wraps where it must.
  const named = <span className="min-w-0 font-medium wrap-anywhere">{name}</span>;

  if (space.role !== "owner") {
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5" data-testid={`assistant-space-${space.id}`}>
        {named}
        <span className="flex flex-col items-end">
          <span>{levelName}</span>
          <span className="text-xs text-fg-3">{t("assistant.levelSetBy")}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`assistant-space-${space.id}`}>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {named}
          <Segmented<MemberAccess>
            label={personal ? t("assistant.levelLabelPersonal") : t("assistant.levelLabel", { space: name })}
            value={level}
            onChange={(next) => change.mutate(next)}
            options={LEVELS.map((entry) => ({ value: entry.value, label: t(entry.label) }))}
          />
        </div>
        <Problem>{change.isError ? t("assistant.saveFailed") : null}</Problem>
      </div>
      {level !== "none" ? <AppChoices space={space} name={name} /> : null}
    </div>
  );
}

/** The apps of a space an owner may leave out of what the assistant may use there. */
function AppChoices({ space, name }: { space: Space; name: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const list = useSpaceApps(space);
  const label = useAppLabel();
  const key = spaceAppsKey(space.id);
  // Kept here, not read off the mutation: with two choices on their way it only knows of the later one.
  const [failed, setFailed] = useState(false);

  const change = useMutation({
    mutationFn: ({ appId, body }: Change) => setAppAccess(space.id, appId, body),
    onMutate: async (variables) => {
      setFailed(false);
      await client.cancelQueries({ queryKey: key });
      const was = client.getQueryData<SpaceApps>(key)?.apps.find((app) => app.id === variables.appId)?.assistant;
      client.setQueryData<SpaceApps>(key, (current) => (current ? applied(current, variables) : current));
      return { was };
    },
    // What was shown ahead of the answer goes back at once: without a connection the list cannot be read again
    // either. Only this app's own box goes back, so that another choice on its way keeps what it shows.
    onError: (_error, { appId }, context) => {
      setFailed(true);
      const was = context?.was;
      if (was === undefined) return;
      client.setQueryData<SpaceApps>(key, (current) => (current ? applied(current, { appId, body: { assistant: was } }) : current));
    },
    // Whether it was saved or not, the server says what is.
    onSettled: () =>
      Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: SESSION_QUERY_KEY })]),
  });

  // The list as it was last read stays on the page when reading it again fails, as the group's own card keeps
  // its table: the boxes, the focus on one of them and the word that a change was not saved must not go away.
  if (!list.data) {
    return list.isError ? (
      <div className="flex flex-col items-start gap-2" role="alert">
        <p className="text-xs text-fg-2">{t("assistant.appsLoadFailed")}</p>
        <Button size="sm" onClick={() => void list.refetch()}>
          <RefreshCw size={14} aria-hidden="true" />
          {t("groups.retry")}
        </Button>
      </div>
    ) : (
      <p className="text-xs text-fg-3" role="status">
        {t("groups.loading")}
      </p>
    );
  }
  // Apps someone can use: those removed from the space or without code on the server are nobody's.
  const apps = list.data.apps.filter((app) => app.removedAt === null && app.hasCode);
  if (apps.length === 0) return <p className="text-xs text-fg-3">{t("assistant.noApps")}</p>;

  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1 text-xs text-fg-3 wrap-anywhere">
        {space.kind === "personal" ? t("assistant.appsLabelPersonal") : t("assistant.appsLabel", { space: name })}
      </legend>
      {apps.map((app) => (
        <Checkbox
          key={app.id}
          checked={app.assistant}
          onChange={(checked) => change.mutate({ appId: app.id, body: { assistant: checked } })}
        >
          {label(app.id).name}
        </Checkbox>
      ))}
      <Problem>{failed ? t("assistant.saveFailed") : null}</Problem>
    </fieldset>
  );
}
