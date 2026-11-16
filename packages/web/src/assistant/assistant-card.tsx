/**
 * The Assistant card in Settings (docs/mini-app-contract.md, section F,
 * build step F3): the address to give Claude, how to connect it, and what
 * Claude may do in each of the person's spaces.
 *
 * Each space's owners choose its level (Off, Read only, Read and change)
 * and may leave single apps out; everyone else sees what they chose. What
 * Claude may then do for a person is worked out on the server (`VISIBLE`),
 * never here, and so is the name Claude knows a space by
 * (`assistantSpaceLabels`).
 */
import { assistantSpaceLabels, type MemberAccess, type Space, type SpaceApps } from "@hearth/shared";
import { Button, Checkbox, Field, Input, Segmented, buttonClass } from "@hearth/sdk/web";
import { focusManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardHeader } from "../components/card";
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

/** Opens Claude's dialog that adds a custom connector, with Hearth's name and address filled in. */
export function addToClaudeLink(address: string): string {
  const query = new URLSearchParams({ modal: "add-custom-connector", connectorName: "Hearth", connectorUrl: address });
  return `https://claude.ai/customize/connectors?${query.toString()}`;
}

/** A session read less than this long ago is not read again: opening Settings as the first page asks once. */
const SESSION_FRESH_MS = 5_000;

/**
 * Reads the session again when the card comes on screen and whenever the
 * window is looked at again. The web app loads the session once, and a
 * space's level may have been changed since, by another owner or on another
 * device: the card must not go on showing "Off" for a space Claude may now
 * change, nor the other way round.
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
  // The assistant's MCP endpoint on this server (section F, "The endpoint").
  const address = `${window.location.origin}/mcp`;
  // What Claude's tools call each space: its name, unless two of the person's spaces share one.
  const labels = assistantSpaceLabels(session.spaces);

  return (
    <Card aria-label={t("assistant.title")}>
      <CardHeader icon={<Bot size={16} aria-hidden="true" />} title={t("assistant.title")} />
      <div className="flex flex-col gap-4">
        <p className="text-fg-2">{t("assistant.intro")}</p>
        <Address address={address} />
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-fg-2">
          <li>{t("assistant.step1")}</li>
          <li>{t("assistant.step2")}</li>
          <li>{t("assistant.step3")}</li>
        </ol>
        <p className="text-xs text-fg-3">{t("assistant.refreshNote")}</p>

        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <div className="flex flex-col gap-0.5">
            <h3 className="font-medium">{t("assistant.spacesTitle")}</h3>
            <p className="text-xs text-fg-3">{t("assistant.youAlways")}</p>
          </div>
          {session.spaces.map((space) => (
            <SpaceLevel key={space.id} space={space} label={labels.get(space.id) ?? space.name} />
          ))}
        </div>
      </div>
    </Card>
  );
}

type CopyStatus = "idle" | "copied" | "failed";

function Address({ address }: { address: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CopyStatus>("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  const copy = () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setStatus("failed");
      return;
    }
    clipboard.writeText(address).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    );
  };

  return (
    <Field label={t("assistant.address")} hint={t("assistant.addressHint")} className="items-stretch">
      {({ id, hintId }) => (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={id}
              aria-describedby={hintId}
              readOnly
              value={address}
              className="min-w-0 flex-1 basis-[220px] font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" onClick={copy}>
              {status === "copied" ? t("assistant.copied") : t("assistant.copy")}
            </Button>
            <a href={addToClaudeLink(address)} target="_blank" rel="noreferrer" className={buttonClass({ size: "sm", variant: "primary" })}>
              {t("assistant.addToClaude")}
            </a>
          </div>
          {/* The button's own text changes too, which a screen reader does not say of the button it is on. */}
          <span role="status" className={status === "failed" ? "text-xs text-down" : "sr-only"}>
            {status === "failed" ? t("assistant.copyFailed") : status === "copied" ? t("assistant.copied") : ""}
          </span>
        </div>
      )}
    </Field>
  );
}

function SpaceLevel({ space, label }: { space: Space; label: string }) {
  const { t } = useI18n();
  const personal = space.kind === "personal";
  const name = personal ? t("nav.personal") : space.name;
  const change = useGroupChange(space.id, (level: MemberAccess) => setAssistantLevel(space.id, level));
  // What was asked for shows at once; the session says what was saved once it is loaded again.
  const level = change.isPending ? change.variables : space.assistant;
  const levelName = t(LEVELS.find((entry) => entry.value === level)!.label);
  // Any name fits the card: a long one without a space wraps where it must.
  const named = (
    <span className="flex min-w-0 flex-col">
      <span className="font-medium wrap-anywhere">{name}</span>
      {/* Claude's approval prompt shows this name, so the person must be able to find it here. */}
      {label === name ? null : <span className="text-xs text-fg-3 wrap-anywhere">{t("assistant.calledBy", { label })}</span>}
    </span>
  );

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

/** The apps of a space an owner may leave out of what Claude may use there. */
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
