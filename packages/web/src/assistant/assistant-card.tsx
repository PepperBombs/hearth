/**
 * The Assistant card in Settings (docs/mini-app-contract.md, section F,
 * build step F3): the address to give Claude, how to connect it, and what
 * Claude may do in each of the person's spaces.
 *
 * Each space's owners choose its level (Off, Read only, Read and change)
 * and may leave single apps out; everyone else sees what they chose. What
 * Claude may then do for a person is worked out on the server (`VISIBLE`),
 * never here.
 */
import type { MemberAccess, Space, SpaceApps } from "@hearth/shared";
import { Button, Checkbox, Field, Input, Segmented, buttonClass } from "@hearth/sdk/web";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
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

export function AssistantCard() {
  const { t } = useI18n();
  const session = useSession();
  // The assistant's MCP endpoint on this server (section F, "The endpoint").
  const address = `${window.location.origin}/mcp`;

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
            <SpaceLevel key={space.id} space={space} />
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
          <span role="status" className="text-xs text-down">
            {status === "failed" ? t("assistant.copyFailed") : ""}
          </span>
        </div>
      )}
    </Field>
  );
}

function SpaceLevel({ space }: { space: Space }) {
  const { t } = useI18n();
  const name = space.kind === "personal" ? t("nav.personal") : space.name;
  const change = useGroupChange(space.id, (level: MemberAccess) => setAssistantLevel(space.id, level));
  // What was asked for shows at once; the session says what was saved once it is loaded again.
  const level = change.isPending ? change.variables : space.assistant;
  const levelName = t(LEVELS.find((entry) => entry.value === level)!.label);

  if (space.role !== "owner") {
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5" data-testid={`assistant-space-${space.id}`}>
        <span className="font-medium">{name}</span>
        <span className="flex flex-col items-end">
          <span>{levelName}</span>
          <span className="text-xs text-fg-3">{t("assistant.levelSetBy")}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`assistant-space-${space.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{name}</span>
        <Segmented<MemberAccess>
          label={t("assistant.levelLabel", { space: name })}
          value={level}
          onChange={(next) => change.mutate(next)}
          options={LEVELS.map((entry) => ({ value: entry.value, label: t(entry.label) }))}
        />
      </div>
      {change.isError ? (
        <p role="status" className="text-xs text-down">
          {t("assistant.saveFailed")}
        </p>
      ) : null}
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

  const change = useMutation({
    mutationFn: ({ appId, body }: Change) => setAppAccess(space.id, appId, body),
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<SpaceApps>(key, (current) => (current ? applied(current, variables) : current));
    },
    // Whether it was saved or not, the server says what is.
    onSettled: () =>
      Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: SESSION_QUERY_KEY })]),
  });

  if (list.isPending) return <p className="text-xs text-fg-3">{t("groups.loading")}</p>;
  if (list.isError) {
    return (
      <p className="text-xs text-down" role="status">
        {t("assistant.appsLoadFailed")}
      </p>
    );
  }
  // Apps someone can use: those removed from the space or without code on the server are nobody's.
  const apps = list.data.apps.filter((app) => app.removedAt === null && app.hasCode);
  if (apps.length === 0) return <p className="text-xs text-fg-3">{t("assistant.noApps")}</p>;

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs text-fg-3">{t("assistant.appsLabel", { space: name })}</legend>
      {apps.map((app) => (
        <Checkbox
          key={app.id}
          checked={app.assistant}
          onChange={(checked) => change.mutate({ appId: app.id, body: { assistant: checked } })}
        >
          {label(app.id).name}
        </Checkbox>
      ))}
      {change.isError ? (
        <p role="status" className="text-xs text-down">
          {t("assistant.saveFailed")}
        </p>
      ) : null}
    </fieldset>
  );
}
