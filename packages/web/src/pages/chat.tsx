/**
 * The chat (docs/platform.md, "The chat"): the person tells their own model
 * what they want to keep track of, and it makes an app for it in the chosen
 * space, or adds to and changes the rows of an app there. What it did shows
 * in the conversation, and an app it made shows right there, as on the
 * dashboard.
 *
 * The conversation lives in this page only; the server keeps none of it.
 */
import type { ChatEvent, ChatFailure, ChatMessage, Space } from "@hearth/shared";
import { Button, Segmented, buttonClass } from "@hearth/sdk/web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Card } from "../components/card";
import { Page } from "../components/shell/page";
import { setAssistantLevel } from "../groups/api";
import type { PlainMessageKey } from "../i18n";
import { MadeAppFrame, notifyMadeAppChanged } from "../made/frame";
import { MODEL_QUERY_KEY, fetchModelSettings, streamChat } from "../made/api";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "model"; text: string }
  | { kind: "action"; action: "app_created" | "row_added" | "row_updated"; appId: string; appName: string }
  | { kind: "failure"; failure: ChatFailure | "network" | "stopped"; detail: string };

const FAILURES: Record<ChatFailure | "network" | "stopped", PlainMessageKey | "chat.failModel"> = {
  no_model: "chat.failNoModel",
  no_key: "chat.failNoKey",
  no_secret: "chat.failNoSecret",
  model_refused_key: "chat.failKey",
  model_failed: "chat.failModel",
  model_declined: "chat.failDeclined",
  too_many_steps: "chat.failSteps",
  assistant_off: "chat.failOff",
  network: "chat.failNetwork",
  stopped: "chat.stopped",
};

const ACTIONS = {
  app_created: "chat.actionAppCreated",
  row_added: "chat.actionRowAdded",
  row_updated: "chat.actionRowUpdated",
} as const;

/** The server takes requests of up to 64 kB: the oldest messages are left out to stay well below. */
const HISTORY_BUDGET = 40_000;

function history(entries: readonly Entry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") messages.push({ role: "user", content: entry.text });
    else if (entry.kind === "model") messages.push({ role: "assistant", content: entry.text });
  }
  let size = 0;
  let from = messages.length;
  while (from > 0 && size + messages[from - 1]!.content.length < HISTORY_BUDGET) size += messages[--from]!.content.length;
  // The conversation sent starts with something the person said.
  while (from < messages.length && messages[from]!.role !== "user") from++;
  return messages.slice(from);
}

export function Chat() {
  const session = useSession();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const model = useQuery({ queryKey: MODEL_QUERY_KEY, queryFn: ({ signal }) => fetchModelSettings(signal) });
  const personal = session.spaces.find((space) => space.kind === "personal");
  const [spaceId, setSpaceId] = useState(personal?.id ?? session.spaces[0]?.id ?? "");
  const space = session.spaces.find((candidate) => candidate.id === spaceId);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // In a block: scrollIntoView returns a promise in newer browsers, which an effect must not return.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);
  useEffect(() => () => running?.abort(), [running]);

  const ready = model.data?.hasKey === true && space !== undefined && space.assistant !== "none";

  const send = async (text: string) => {
    if (!space || text.trim() === "" || running) return;
    const asked: Entry[] = [...entries, { kind: "user", text }];
    setEntries(asked);
    setDraft("");
    const stop = new AbortController();
    setRunning(stop);
    const add = (entry: Entry) => setEntries((current) => [...current, entry]);
    const onEvent = (event: ChatEvent) => {
      if (event.type === "text") add({ kind: "model", text: event.text });
      else if (event.type === "error") add({ kind: "failure", failure: event.failure, detail: event.detail });
      else if (event.type === "action") {
        add({ kind: "action", action: event.action, appId: event.appId, appName: event.appName });
        // A new app comes with the session; a changed row, to every page of its app on screen.
        if (event.action === "app_created") void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        else notifyMadeAppChanged(event.appId);
      }
    };
    try {
      await streamChat({ spaceId: space.id, messages: history(asked) }, onEvent, stop.signal);
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      add({ kind: "failure", failure: stopped ? "stopped" : "network", detail: "" });
    } finally {
      setRunning(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  };

  return (
    <Page title={t("chat.title")}>
      <div className="mx-auto flex max-w-[760px] flex-col gap-4">
        <p className="text-fg-2">{t("chat.intro")}</p>
        {session.spaces.length > 1 ? (
          <Segmented<string>
            label={t("chat.space")}
            value={spaceId}
            onChange={setSpaceId}
            options={session.spaces.map((candidate) => ({
              value: candidate.id,
              label: candidate.kind === "personal" ? t("chat.personal") : candidate.name,
            }))}
          />
        ) : null}

        {model.isSuccess && model.data?.hasKey !== true ? (
          <Card className="items-start gap-3">
            <p>{t("chat.noModel")}</p>
            <Link to="/settings" className={buttonClass({ variant: "primary" })}>
              {t("chat.chooseModel")}
            </Link>
          </Card>
        ) : null}
        {space && space.assistant === "none" ? <AllowHere space={space} /> : null}

        <div className="flex flex-col gap-3" aria-live="polite">
          {entries.map((entry, index) => (
            <EntryView key={index} entry={entry} />
          ))}
          {running ? <p className="text-fg-3">{t("chat.working")}</p> : null}
          <div ref={end} />
        </div>

        <form onSubmit={submit} className="flex flex-col gap-2">
          <textarea
            aria-label={t("chat.placeholder")}
            placeholder={t("chat.placeholder")}
            rows={3}
            value={draft}
            disabled={!ready}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className="w-full resize-y rounded-ctl border border-line bg-surface px-2.5 py-2 text-fg placeholder:text-fg-3 disabled:opacity-55 max-md:text-lg"
          />
          <div className="flex justify-end gap-2">
            {running ? (
              <Button type="button" onClick={() => running.abort()}>
                <Square size={14} aria-hidden="true" />
                {t("chat.stop")}
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!ready || draft.trim() === ""}>
                <Send size={14} aria-hidden="true" />
                {t("chat.send")}
              </Button>
            )}
          </div>
        </form>
      </div>
    </Page>
  );
}

/** The space's assistant is off: its owners may switch it on here, for their own model and everyone's. */
function AllowHere({ space }: { space: Space }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const allow = async () => {
    setState("saving");
    try {
      await setAssistantLevel(space.id, "edit");
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  return (
    <Card className="items-start gap-3">
      <p>{t("chat.assistantOff")}</p>
      {space.role === "owner" ? (
        <Button variant="primary" disabled={state === "saving"} onClick={() => void allow()}>
          {t("chat.allowHere")}
        </Button>
      ) : (
        <p className="text-fg-3">{t("chat.askOwner")}</p>
      )}
      {state === "failed" ? (
        <p role="alert" className="text-down">
          {t("chat.allowFailed")}
        </p>
      ) : null}
    </Card>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  const { t } = useI18n();
  const session = useSession();
  const app = useMemo(
    () => (entry.kind === "action" ? session.apps.find((candidate) => candidate.id === entry.appId) : undefined),
    [entry, session.apps],
  );
  switch (entry.kind) {
    case "user":
      return (
        <div className="self-end whitespace-pre-wrap rounded-card bg-accent-soft px-3 py-2 text-fg max-w-[85%]">
          <span className="sr-only">{t("chat.you")}: </span>
          {entry.text}
        </div>
      );
    case "model":
      return (
        <div className="self-start whitespace-pre-wrap rounded-card border border-line bg-surface px-3 py-2 max-w-[85%]">
          <span className="sr-only">{t("chat.model")}: </span>
          {entry.text}
        </div>
      );
    case "action":
      return (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-fg-2">
            <Check size={16} aria-hidden="true" className="text-accent" />
            {t(ACTIONS[entry.action], { app: entry.appName })}
          </p>
          {/* The app it made, drawn as on the dashboard, once the session holds it. */}
          {entry.action === "app_created" && app ? (
            <Card className="p-0">
              <MadeAppFrame app={app} />
            </Card>
          ) : null}
        </div>
      );
    case "failure": {
      const key = FAILURES[entry.failure];
      return (
        <p role="alert" className="text-down">
          {key === "chat.failModel" ? t(key, { detail: entry.detail }) : t(key)}
        </p>
      );
    }
  }
}
