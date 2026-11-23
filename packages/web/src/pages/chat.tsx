/**
 * The chat (docs/platform.md, "The chat"): the person tells their own model
 * what they want to keep track of, and it makes an app for it in the chosen
 * space, or adds to and changes the rows of an app there. What it did shows
 * in the conversation, and an app it made shows right there, as on the
 * dashboard.
 *
 * The server keeps each conversation, for the person alone, in its space:
 * the space and the open conversation are in the address
 * (`/chat?space=<id>&chat=<id>`), the person's conversations in that space
 * are listed beside it, and the server gives the model what was said
 * before. Leaving the open conversation (another one, a new one, another
 * space, another page) stops a turn that is still running.
 */
import type { AppSummary, ChatEntry, ChatEvent, ChatFailure, ChatSummary, Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, IconButton, Segmented, buttonClass } from "@hearth/sdk/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessagesSquare, Plus, Send, Square, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Card } from "../components/card";
import { Page } from "../components/shell/page";
import { setAssistantLevel } from "../groups/api";
import type { PlainMessageKey } from "../i18n";
import { formatWhen } from "../lib/date";
import { MadeAppFrame, notifyMadeAppChanged } from "../made/frame";
import { MODEL_QUERY_KEY, deleteChat, fetchModelSettings, listChats, readChat, restoreVersion, streamChat } from "../made/api";
import { ApiRequestError } from "../session/api";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";

/** What the page shows: the kept entries, and two of its own, which are never kept. */
type Entry = ChatEntry | { kind: "failure"; failure: "network" | "stopped"; detail: string };

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

/** Why a message was not taken, or a conversation could not be opened: the server refused before anything was kept. */
type Notice = "gone" | "busy" | "full" | "tooMany";

const NOTICES: Record<Notice, PlainMessageKey> = {
  gone: "chat.gone",
  busy: "chat.busy",
  full: "chat.full",
  tooMany: "chat.tooMany",
};

const chatsQueryKey = (spaceId: string) => ["chats", spaceId] as const;
const chatQueryKey = (chatId: string | undefined) => ["chat", chatId] as const;

/** The address of a conversation, or of a new one in the space. */
function chatSearch(spaceId: string, chatId?: string): URLSearchParams {
  const search = new URLSearchParams({ space: spaceId });
  if (chatId !== undefined) search.set("chat", chatId);
  return search;
}

/** A dropped connection or a server fault is worth one more go; "not found" is not. */
function retryOnce(failures: number, error: unknown): boolean {
  return failures < 1 && error instanceof ApiRequestError && (error.code === "network" || error.status >= 500);
}

/** The entries on screen, and which conversation they are of (`<spaceId>/<chatId>`, the ID left out for a new one). */
type Shown = { key: string; entries: Entry[] };
const NOTHING_SHOWN: Shown = { key: "", entries: [] };

const isGone = (error: unknown) => error instanceof ApiRequestError && error.status === 404;

export function Chat() {
  const session = useSession();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const model = useQuery({ queryKey: MODEL_QUERY_KEY, queryFn: ({ signal }) => fetchModelSettings(signal) });
  const personal = session.spaces.find((candidate) => candidate.kind === "personal");
  // The space of the address, or the personal one when it names none the person is in.
  const space = session.spaces.find((candidate) => candidate.id === search.get("space")) ?? personal ?? session.spaces[0];
  const spaceId = space?.id ?? "";
  const chatId = search.get("chat") || undefined;
  /** Which conversation is open: a new one in a space has no ID yet. */
  const openKey = `${spaceId}/${chatId ?? ""}`;

  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  const [notice, setNotice] = useState<{ key: string; notice: Notice } | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<AbortController | null>(null);
  const turn = useRef<{ key: string; stop: AbortController } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ spaceId: string; chat: ChatSummary } | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const chats = useQuery({
    queryKey: chatsQueryKey(spaceId),
    queryFn: ({ signal }) => listChats(spaceId, signal),
    enabled: spaceId !== "",
    retry: retryOnce,
  });

  // A conversation is read when it is opened, and not again while it is on screen: the page adds what a turn sends.
  const needsLoad = chatId !== undefined && shown.key !== openKey;
  const loaded = useQuery({
    queryKey: chatQueryKey(chatId),
    queryFn: ({ signal }) => readChat(spaceId, chatId!, signal),
    enabled: needsLoad,
    retry: retryOnce,
    // Read afresh each time it is opened: what was read before may be from the middle of a turn.
    gcTime: 0,
  });
  const entries = shown.key === openKey ? shown.entries : [];

  const open = (next: URLSearchParams, replace = false) => setSearch(next, { replace });
  const startNew = (replace = false) => {
    // When a new one is open already, what was said in it before it had an ID goes. (Otherwise leaving clears it.)
    if (chatId === undefined) {
      // A turn that has no ID yet stops too, or its "chat" event would open it again.
      turn.current?.stop.abort();
      setShown(NOTHING_SHOWN);
    }
    open(chatSearch(spaceId), replace);
  };

  // A conversation that is gone, or not the person's, opens a new one instead.
  const loadError = needsLoad ? loaded.error : null;
  useEffect(() => {
    if (!isGone(loadError)) return;
    setNotice({ key: `${spaceId}/`, notice: "gone" });
    void queryClient.invalidateQueries({ queryKey: chatsQueryKey(spaceId) });
    setSearch(chatSearch(spaceId), { replace: true });
  }, [loadError, spaceId, queryClient, setSearch]);

  // Leaving the open conversation stops its turn, as leaving the page does, and it is read afresh when opened again.
  useEffect(() => {
    if (turn.current && turn.current.key !== openKey) turn.current.stop.abort();
    setShown((now) => (now.key === openKey ? now : NOTHING_SHOWN));
  }, [openKey]);
  // What was read becomes what is shown; a new conversation shows nothing until something is said in it.
  const read = needsLoad && loaded.data?.chat.id === chatId && !loaded.isFetching ? loaded.data : undefined;
  useEffect(() => {
    if (read) setShown({ key: openKey, entries: read.entries });
  }, [read, openKey]);
  useEffect(() => () => turn.current?.stop.abort(), []);

  // In a block: scrollIntoView returns a promise in newer browsers, which an effect must not return.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  const ready = model.data?.hasKey === true && space !== undefined && space.assistant !== "none" && !needsLoad;

  const send = async (text: string) => {
    if (!space || !ready || text.trim() === "" || running) return;
    const sentSpace = space.id;
    const sentChat = chatId;
    // What a new conversation shows before its first message is of a turn that never got its ID: it is not of this one.
    const before = sentChat === undefined ? [] : entries;
    const current = { key: openKey, stop: new AbortController() };
    turn.current = current;
    setShown({ key: openKey, entries: [...before, { kind: "user", text }] });
    setDraft("");
    setNotice(null);
    setRunning(current.stop);
    const add = (entry: Entry) => setShown((now) => (now.key === current.key ? { ...now, entries: [...now.entries, entry] } : now));
    const onEvent = (event: ChatEvent) => {
      if (current.stop.signal.aborted) return;
      if (event.type === "chat") {
        // The new conversation has its ID: into the address, in place of the new one, and into the list.
        const was = current.key;
        const key = `${sentSpace}/${event.chatId}`;
        setShown((now) => (now.key === was ? { ...now, key } : now));
        current.key = key;
        open(chatSearch(sentSpace, event.chatId), true);
        void queryClient.invalidateQueries({ queryKey: chatsQueryKey(sentSpace) });
      } else if (event.type === "text") add({ kind: "model", text: event.text });
      else if (event.type === "error") add({ kind: "failure", failure: event.failure, detail: event.detail });
      else if (event.type === "action") {
        add({
          kind: "action",
          action: event.action,
          appId: event.appId,
          appName: event.appName,
          ...(event.version === undefined ? {} : { version: event.version }),
          ...(event.previous === undefined ? {} : { previous: event.previous }),
          ...(event.restored === undefined ? {} : { restored: event.restored }),
        });
        // A new app, or a new version of one, comes with the session, and its page is drawn afresh;
        // a changed row goes to every page of its app on screen.
        if (event.action === "row_added" || event.action === "row_updated") notifyMadeAppChanged(event.appId);
        else void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
    };
    try {
      await streamChat({ spaceId: sentSpace, ...(sentChat === undefined ? {} : { chatId: sentChat }), message: text }, onEvent, current.stop.signal);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 409)) {
        // Refused before anything was kept: the message goes back into the box.
        setShown((now) => (now.key === current.key ? { ...now, entries: before } : now));
        setDraft((typed) => (typed.trim() === "" ? text : typed));
        if (error.status === 404) {
          // The conversation is gone (deleted elsewhere), or the space is no longer the person's.
          setNotice({ key: `${sentSpace}/`, notice: "gone" });
          if (sentChat === undefined) void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          else open(chatSearch(sentSpace), true);
        } else {
          const refused: Notice = sentChat === undefined ? "tooMany" : /full/i.test(error.message) ? "full" : "busy";
          setNotice({ key: current.key, notice: refused });
        }
      } else {
        const stopped = error instanceof DOMException && error.name === "AbortError";
        add({ kind: "failure", failure: stopped ? "stopped" : "network", detail: "" });
      }
    } finally {
      if (turn.current === current) turn.current = null;
      setRunning(null);
      void queryClient.invalidateQueries({ queryKey: chatsQueryKey(sentSpace) });
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

  const shownNotice = notice?.key === openKey ? notice.notice : null;
  const list = (onPick: () => void, onDelete: (chat: ChatSummary) => void) => (
    <ChatList
      spaceId={spaceId}
      chats={chats.data}
      failed={chats.isError}
      onRetry={() => void chats.refetch()}
      openId={chatId}
      onPick={onPick}
      onNew={() => {
        onPick();
        startNew();
      }}
      onDelete={onDelete}
    />
  );

  return (
    <Page title={t("chat.title")}>
      <div className="mx-auto flex max-w-[1060px] items-start gap-6">
        <aside className="sticky top-0 flex max-h-[calc(100dvh-104px)] w-60 flex-none flex-col overflow-y-auto @max-[768px]/main:hidden">
          {list(
            () => {},
            (chat) => setDeleting({ spaceId, chat }),
          )}
        </aside>

        <div className="mx-auto flex min-w-0 max-w-[760px] flex-1 flex-col gap-4">
          <p className="text-fg-2">{t("chat.intro")}</p>
          {session.spaces.length > 1 ? (
            <Segmented<string>
              label={t("chat.space")}
              value={spaceId}
              onChange={(next) => open(chatSearch(next))}
              options={session.spaces.map((candidate) => ({
                value: candidate.id,
                label: candidate.kind === "personal" ? t("chat.personal") : candidate.name,
              }))}
            />
          ) : null}
          {/*
           * Where the list is not beside the conversation. Like the dashboard's
           * grid, this measures the main column, not the window: the theme has
           * one breakpoint (md), and 768px is the room the list and a readable
           * conversation need side by side.
           */}
          <div className="flex flex-wrap gap-2 @min-[768px]/main:hidden">
            <Button onClick={() => setListOpen(true)}>
              <MessagesSquare size={14} aria-hidden="true" />
              {t("chat.conversations")}
            </Button>
            <Button onClick={() => startNew()}>
              <Plus size={14} aria-hidden="true" />
              {t("chat.newConversation")}
            </Button>
          </div>

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
            {needsLoad && loaded.isPending ? <p className="text-fg-3">{t("chat.loading")}</p> : null}
            {needsLoad && loaded.isError && !isGone(loaded.error) ? (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-down">
                  {t("chat.loadFailed")}
                </p>
                <Button size="sm" onClick={() => void loaded.refetch()}>
                  {t("chat.retry")}
                </Button>
              </div>
            ) : null}
            {entries.map((entry, index) => (
              <EntryView key={index} entry={entry} />
            ))}
            {running ? <p className="text-fg-3">{t("chat.working")}</p> : null}
            <div ref={end} />
          </div>

          {shownNotice ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-down">
                {t(NOTICES[shownNotice])}
              </p>
              {shownNotice === "full" ? (
                <Button size="sm" variant="primary" onClick={() => startNew()}>
                  {t("chat.newConversation")}
                </Button>
              ) : null}
            </div>
          ) : null}

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
      </div>

      <Dialog open={listOpen} onClose={() => setListOpen(false)} label={t("chat.conversations")}>
        <DialogBody className="max-h-[calc(100dvh-34px)] overflow-y-auto">
          {list(
            () => setListOpen(false),
            (chat) => {
              setListOpen(false);
              setDeleting({ spaceId, chat });
            },
          )}
          <div className="flex justify-end">
            <Button onClick={() => setListOpen(false)}>{t("chat.close")}</Button>
          </div>
        </DialogBody>
      </Dialog>

      {deleting ? (
        <DeleteDialog
          spaceId={deleting.spaceId}
          chat={deleting.chat}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            // Deleting the open conversation starts a new one.
            if (deleting.chat.id === chatId) startNew(true);
          }}
        />
      ) : null}
    </Page>
  );
}

type ChatListProps = {
  spaceId: string;
  chats: ChatSummary[] | undefined;
  failed: boolean;
  onRetry: () => void;
  openId: string | undefined;
  /** A conversation was chosen, or a new one asked for. */
  onPick: () => void;
  onNew: () => void;
  onDelete: (chat: ChatSummary) => void;
};

/** The person's conversations in the space, the one used last first, with a way to start a new one. */
function ChatList({ spaceId, chats, failed, onRetry, openId, onPick, onNew, onDelete }: ChatListProps) {
  const { t, locale } = useI18n();
  const now = new Date();
  return (
    <nav aria-label={t("chat.conversations")} className="flex min-w-0 flex-col gap-2">
      <h2 className="text-md font-semibold">{t("chat.conversations")}</h2>
      <Button className="justify-start" onClick={onNew}>
        <Plus size={14} aria-hidden="true" />
        {t("chat.newConversation")}
      </Button>
      {failed && chats === undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-down">
            {t("chat.listFailed")}
          </p>
          <Button size="sm" onClick={onRetry}>
            {t("chat.retry")}
          </Button>
        </div>
      ) : chats === undefined ? (
        <p className="text-fg-3">{t("chat.loading")}</p>
      ) : chats.length === 0 ? (
        <p className="text-fg-3">{t("chat.noConversations")}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {chats.map((chat) => (
            <li key={chat.id} className="flex min-w-0 items-center gap-1">
              <Link
                to={{ pathname: "/chat", search: `?${chatSearch(spaceId, chat.id).toString()}` }}
                aria-current={chat.id === openId ? "page" : undefined}
                onClick={onPick}
                className={
                  "flex min-w-0 flex-1 flex-col rounded-ctl px-2 py-1.5 text-fg-2 hover:bg-hover hover:text-fg max-md:py-2.5 " +
                  "aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-fg " +
                  "aria-[current=page]:shadow-[inset_3px_0_0_var(--hearth-accent)]"
                }
              >
                <span className="clip font-medium">{chat.title}</span>
                <time dateTime={chat.updatedAt} className="text-xs text-fg-3">
                  {formatWhen(new Date(chat.updatedAt), now, locale)}
                </time>
              </Link>
              <IconButton label={t("chat.delete", { title: chat.title })} onClick={() => onDelete(chat)}>
                <Trash2 size={16} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** Asks before a conversation is deleted. One that is gone already counts as deleted. */
function DeleteDialog({ spaceId, chat, onClose, onDeleted }: { spaceId: string; chat: ChatSummary; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const remove = useMutation({ mutationFn: () => deleteChat(spaceId, chat.id) });
  const confirm = () => {
    remove
      .mutateAsync()
      .catch((error: unknown) => {
        if (!isGone(error)) throw error;
      })
      .then(
        () => {
          queryClient.setQueryData<ChatSummary[]>(chatsQueryKey(spaceId), (list) => list?.filter((candidate) => candidate.id !== chat.id));
          void queryClient.invalidateQueries({ queryKey: chatsQueryKey(spaceId) });
          queryClient.removeQueries({ queryKey: chatQueryKey(chat.id) });
          onDeleted();
        },
        () => {},
      );
  };
  return (
    <Dialog open onClose={onClose} label={t("chat.deleteTitle")}>
      <DialogBody>
        <h2 className="text-md font-semibold">{t("chat.deleteTitle")}</h2>
        <p className="clip font-medium">{chat.title}</p>
        <p className="text-fg-2">{t("chat.deleteBody")}</p>
        {remove.isError && !isGone(remove.error) ? (
          <p role="alert" className="text-xs text-down">
            {t("chat.deleteFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("chat.cancel")}</Button>
          <Button variant="primary" disabled={remove.isPending} onClick={confirm}>
            {t("chat.deleteConfirm")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
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
          <p className="flex flex-wrap items-center gap-1.5 text-fg-2">
            <Check size={16} aria-hidden="true" className="text-accent" />
            {entry.action === "app_updated"
              ? t("chat.actionAppUpdated", { app: entry.appName, version: entry.version ?? 0 })
              : entry.action === "app_restored"
                ? t("chat.actionAppRestored", { app: entry.appName, restored: entry.restored ?? 0 })
                : t(ACTIONS[entry.action], { app: entry.appName })}
            {(entry.action === "app_updated" || entry.action === "app_restored") &&
            app &&
            entry.previous !== undefined &&
            entry.version !== undefined ? (
              <Undo app={app} version={entry.previous} made={entry.version} />
            ) : null}
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

/**
 * Undoes a change the model made to an app: the version before it comes
 * back into use, as a new version, which the server refuses when an entry
 * written since would not fit it. Offered only while the version in use is
 * still the one the change made (`made`), also in a conversation opened
 * again later.
 */
function Undo({ app, version, made }: { app: AppSummary; version: number; made: number }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [state, setState] = useState<"idle" | "working" | "done" | "conflict" | "failed">("idle");
  const undo = async () => {
    setState("working");
    try {
      await restoreVersion(app.spaceId, app.id, version);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      setState("done");
    } catch (error) {
      setState(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "failed");
    }
  };
  if (state === "done") return <span className="text-fg-3">{t("chat.undone")}</span>;
  // Another change came since (this person's, or someone else's in a group): undoing to `version` now
  // would take that back too, so this entry no longer offers it. An Undo already done made a newer version too.
  if (app.version !== made) return null;
  return (
    <>
      <Button size="sm" disabled={state === "working"} onClick={() => void undo()}>
        <Undo2 size={14} aria-hidden="true" />
        {t("chat.undo")}
      </Button>
      {state === "conflict" || state === "failed" ? (
        <span role="alert" className="basis-full text-down">
          {t(state === "conflict" ? "chat.undoConflict" : "chat.undoFailed")}
        </span>
      ) : null}
    </>
  );
}

