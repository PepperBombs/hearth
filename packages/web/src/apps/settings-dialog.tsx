/**
 * The settings of one app in one space, in a dialog the shell draws from
 * the app's manifest (docs/mini-app-contract.md, section A8). The app writes
 * no form of its own: each setting it declares becomes a control of its
 * type, with its label and help in the reader's language.
 *
 * The form has two groups. "For everyone in this space" holds the
 * space-scope settings, which need edit access; for someone who may only
 * view the app they are shown and cannot be changed. "Only for you" holds
 * the reader's own, which are always theirs to change (owner's decision 5).
 *
 * Saving sends only the values the person changed: a value that is saved
 * stays saved even when it equals today's default, so sending the rest would
 * pin them to it. The server saves the request as a whole or not at all and
 * answers with every setting as it now holds them; the app's queries are then
 * read again, since a route may read its settings.
 */
import type { Manifest, Setting } from "@hearth/sdk";
import { settingValueProblems } from "@hearth/sdk/manifest-schema";
import { Button, Chip, Dialog, Field, IconButton, Input, Segmented, Switch } from "@hearth/sdk/web";
import type { AppSettings, AppSettingsPatch, AppSummary, SettingValue } from "@hearth/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, RefreshCw, X } from "lucide-react";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { AppIcon } from "../components/app-icon";
import { pickLocalized, type Translate } from "../i18n";
import { cx } from "../lib/cx";
import { failureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { useSession } from "../session/session";
import { saveAppSettings, type Install } from "./api";
import { forApp, installQueryKey, settingsQuery, settingsQueryKey } from "./scope";

export type AppSettingsDialogProps = {
  /** The app in its space, as the session lists it. */
  app: AppSummary;
  /** The app's manifest, from the build: what its settings are. */
  manifest: Manifest;
  open: boolean;
  onClose: () => void;
};

export function AppSettingsDialog({ app, manifest, open, onClose }: AppSettingsDialogProps) {
  const { locale, t } = useI18n();
  const title = t("appSettings.title", { app: pickLocalized(app.name, locale) });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={title}
      layoutClassName="m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[520px] rounded-card border"
    >
      <div className="flex max-h-[calc(100dvh-34px)] flex-col">
        <div className="flex flex-none items-center gap-2 border-b border-line px-5 py-3.5">
          <AppIcon icon={app.icon} color={app.color} />
          <h2 className="clip min-w-0 text-md font-semibold">{title}</h2>
        </div>
        <SettingsLoader app={app} manifest={manifest} onClose={onClose} />
      </div>
    </Dialog>
  );
}

/** The settings as the server holds them, shared with the app's own code in the same cache. */
function SettingsLoader({ app, manifest, onClose }: Omit<AppSettingsDialogProps, "open">) {
  const { t } = useI18n();
  const client = useQueryClient();
  const install = { spaceId: app.spaceId, appId: app.id };
  const settings = useQuery(settingsQuery(client, install, manifest));

  if (settings.data) {
    return <SettingsForm app={app} manifest={manifest} install={install} saved={settings.data} onClose={onClose} />;
  }
  return (
    <div className="flex flex-col items-start gap-2.5 p-5" role={settings.isError ? "alert" : "status"}>
      {settings.isError ? (
        <>
          <p className="text-fg-2">{t("appSettings.loadFailed")}</p>
          <Button size="sm" onClick={() => void settings.refetch()}>
            <RefreshCw size={14} aria-hidden="true" />
            {t("appSettings.retry")}
          </Button>
        </>
      ) : (
        <p className="text-fg-3">{t("appSettings.loading")}</p>
      )}
    </div>
  );
}

/** What the form holds for a setting: its value, or for a number the text in its box. */
type Draft = Record<string, SettingValue>;

/** Whether two values of a setting are the same. Lists are compared item by item, in order. */
function same(a: SettingValue | undefined, b: SettingValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

/** A number's box holds text; this is the number it stands for, or null when it stands for none. */
function numberFrom(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

type Entry = { name: string; setting: Setting };

/** What is wrong with a value in the form. Only a number's box can hold one that does not fit. */
type Problem = "appSettings.numberNeeded" | "appSettings.numberOff";

function SettingsForm({
  app,
  manifest,
  install,
  saved,
  onClose,
}: {
  app: AppSummary;
  manifest: Manifest;
  install: Install;
  saved: AppSettings;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);
  const canEditSpace = app.access === "edit";

  // What was saved when the dialog opened. Changes are measured against it, so a value
  // someone else saved meanwhile is not sent back unless this person changed it too.
  const [base] = useState<Draft>(() => ({ ...saved.space, ...saved.user }));
  const [values, setValues] = useState<Draft>(base);
  const [numbers, setNumbers] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(base).filter(([, value]) => typeof value === "number").map(([name, value]) => [name, String(value)])),
  );

  const entries: Entry[] = Object.entries(manifest.settings ?? {}).map(([name, setting]) => ({ name, setting }));
  const spaceEntries = entries.filter((entry) => entry.setting.scope === "space");
  const userEntries = entries.filter((entry) => entry.setting.scope === "user");
  const editable = (entry: Entry) => entry.setting.scope === "user" || canEditSpace;

  /** The value a setting would be saved with, or undefined when its box does not hold a number. */
  const valueOf = (entry: Entry): SettingValue | undefined => {
    if (entry.setting.type !== "number") return values[entry.name];
    return numberFrom(numbers[entry.name] ?? "") ?? undefined;
  };
  const changed = entries.filter((entry) => editable(entry) && !same(valueOf(entry), base[entry.name]));
  const problemOf = (entry: Entry): Problem | null => {
    const value = valueOf(entry);
    if (value === undefined) return entry.setting.type === "number" ? "appSettings.numberNeeded" : null;
    return settingValueProblems(entry.setting, value).length > 0 ? "appSettings.numberOff" : null;
  };
  const problems = entries.filter((entry) => editable(entry) && problemOf(entry) !== null);

  const save = useMutation({
    mutationFn: (patch: AppSettingsPatch) => forApp(client, () => saveAppSettings(install, patch)),
    onSuccess: async (answer) => {
      client.setQueryData(settingsQueryKey(install), answer);
      onClose();
      // A route may read the settings, so the app's queries are read again too.
      await client.invalidateQueries({ queryKey: installQueryKey(install) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed.length === 0 || problems.length > 0 || save.isPending) return;
    const patch: AppSettingsPatch = {};
    for (const entry of changed) {
      const value = valueOf(entry);
      if (value === undefined) return;
      const group = (patch[entry.setting.scope] ??= {});
      group[entry.name] = value;
    }
    save.mutate(patch);
  };

  const failure = save.error ? failureCode(save.error) : null;
  const refused = failure === "forbidden" || failure === "invalid_request" || failure === "conflict" || failure === "not_found";
  const message = problems.length > 0 ? t("appSettings.fixFirst") : failure ? t(refused ? "appSettings.saveRefused" : "appSettings.saveFailed") : "";

  const group = (title: string, list: Entry[], disabled: boolean, note?: string) =>
    list.length === 0 ? null : (
      <fieldset disabled={disabled} className={cx("flex min-w-0 flex-col gap-4", disabled && "opacity-70")}>
        <legend className="mb-3 text-xs font-medium text-fg-3">{title}</legend>
        {note ? <p className="-mt-1 text-xs text-fg-3">{note}</p> : null}
        {list.map((entry) => (
          <SettingField
            key={entry.name}
            entry={entry}
            value={values[entry.name]}
            numberText={numbers[entry.name] ?? ""}
            problem={problemOf(entry)}
            disabled={disabled}
            onChange={(value) => setValues((current) => ({ ...current, [entry.name]: value }))}
            onNumberText={(text) => setNumbers((current) => ({ ...current, [entry.name]: text }))}
          />
        ))}
      </fieldset>
    );

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-5">
        {group(
          t(space?.kind === "group" ? "appSettings.space" : "appSettings.spacePersonal"),
          spaceEntries,
          !canEditSpace,
          canEditSpace ? undefined : t("appSettings.spaceViewOnly"),
        )}
        {group(t("appSettings.user"), userEntries, false)}
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        <p role="status" className="mr-auto min-w-0 text-xs text-down">
          {message}
        </p>
        <Button onClick={onClose}>{t("appSettings.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={changed.length === 0 || problems.length > 0 || save.isPending}>
          {t("appSettings.save")}
        </Button>
      </div>
    </form>
  );
}

type SettingFieldProps = {
  entry: Entry;
  value: SettingValue | undefined;
  numberText: string;
  problem: Problem | null;
  disabled: boolean;
  onChange: (value: SettingValue) => void;
  onNumberText: (text: string) => void;
};

/** The rules of a number setting, in words. */
function numberRule(setting: Extract<Setting, { type: "number" }>, t: Translate): string {
  const parts: string[] = [];
  if (setting.min !== undefined && setting.max !== undefined) {
    parts.push(t("appSettings.numberRange", { min: setting.min, max: setting.max }));
  } else if (setting.min !== undefined) {
    parts.push(t("appSettings.numberMin", { min: setting.min }));
  } else if (setting.max !== undefined) {
    parts.push(t("appSettings.numberMax", { max: setting.max }));
  }
  if (setting.step !== undefined) parts.push(t("appSettings.numberStep", { step: setting.step }));
  return parts.join(" ");
}

/** One setting: its label, its help, and the control its type calls for. */
function SettingField({ entry, value, numberText, problem, disabled, onChange, onNumberText }: SettingFieldProps) {
  const { locale, t } = useI18n();
  const { setting } = entry;
  const label = pickLocalized(setting.label, locale);
  const help = setting.help ? pickLocalized(setting.help, locale) : undefined;
  const problemId = useId();

  switch (setting.type) {
    case "text":
      return (
        <Field label={label} hint={help} className="items-stretch">
          {({ id, hintId }) => (
            <Input
              id={id}
              aria-describedby={hintId}
              value={typeof value === "string" ? value : ""}
              maxLength={setting.maxLength}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </Field>
      );
    case "number": {
      const rule = numberRule(setting, t);
      const hint = [help, rule].filter(Boolean).join(" ") || undefined;
      return (
        <Field label={label} hint={hint} className="items-stretch">
          {({ id, hintId }) => (
            <>
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                className="max-w-[200px]"
                aria-describedby={cx(hintId, problem && !disabled && problemId) || undefined}
                aria-invalid={(problem !== null && !disabled) || undefined}
                value={numberText}
                min={setting.min}
                max={setting.max}
                step={setting.step ?? "any"}
                onChange={(event) => onNumberText(event.target.value)}
              />
              {problem && !disabled ? (
                <span id={problemId} className="text-xs text-down">
                  {t(problem)}
                </span>
              ) : null}
            </>
          )}
        </Field>
      );
    }
    case "switch":
      return (
        <Field label={label} hint={help}>
          {({ id, hintId }) => (
            <Switch id={id} aria-describedby={hintId} label={label} checked={value === true} onCheckedChange={onChange} />
          )}
        </Field>
      );
    case "select":
      return (
        <Field label={label} hint={help}>
          <Segmented<string>
            label={label}
            className="flex-wrap"
            value={typeof value === "string" ? value : ""}
            options={Object.entries(setting.options).map(([key, text]) => ({ value: key, label: pickLocalized(text, locale) }))}
            onChange={onChange}
          />
        </Field>
      );
    case "multi-select": {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <Field label={label} hint={help}>
          <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
            {Object.entries(setting.options).map(([key, text]) => (
              <Chip
                key={key}
                pressed={chosen.includes(key)}
                onClick={() =>
                  // Kept in the order of the options, whatever order they were chosen in.
                  onChange(
                    Object.keys(setting.options).filter((option) => (option === key ? !chosen.includes(key) : chosen.includes(option))),
                  )
                }
              >
                {pickLocalized(text, locale)}
              </Chip>
            ))}
          </div>
        </Field>
      );
    }
    case "list":
      return (
        <Field label={label} hint={help} className="items-stretch">
          <ListEditor
            label={label}
            items={Array.isArray(value) ? value : []}
            maxItems={setting.maxItems}
            maxLength={setting.maxLength}
            disabled={disabled}
            onChange={onChange}
          />
        </Field>
      );
  }
}

const SMALL_ICON_BUTTON = "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

/** A list of texts: each can be changed, moved or removed, and new ones are added at the end. */
function ListEditor(props: {
  label: string;
  items: string[];
  maxItems?: number;
  maxLength?: number;
  disabled: boolean;
  onChange: (items: string[]) => void;
}) {
  const { label, items, maxItems, maxLength, disabled, onChange } = props;
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const full = maxItems !== undefined && items.length >= maxItems;

  const add = () => {
    const text = draft.trim();
    if (text === "" || full) return;
    onChange([...items, text]);
    setDraft("");
  };
  const move = (from: number, to: number) => {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onChange(next);
  };
  // Enter in the new entry's box adds it; it does not save the whole form.
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    add();
  };

  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
      {items.length === 0 ? (
        <p className="text-xs text-fg-3">{t("appSettings.listEmpty")}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {items.map((item, index) => {
            const number = index + 1;
            return (
              // The position is the identity here: entries may repeat, and moving one moves its text.
              <li key={index} className="flex min-w-0 items-center gap-1">
                <Input
                  aria-label={t("appSettings.listEntry", { number, setting: label })}
                  value={item}
                  maxLength={maxLength}
                  onChange={(event) => onChange(items.map((other, at) => (at === index ? event.target.value : other)))}
                />
                {disabled ? null : (
                  <>
                    <IconButton
                      label={t("appSettings.listUp", { number })}
                      className={SMALL_ICON_BUTTON}
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t("appSettings.listDown", { number })}
                      className={SMALL_ICON_BUTTON}
                      disabled={index === items.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t("appSettings.listRemove", { number })}
                      className={SMALL_ICON_BUTTON}
                      onClick={() => onChange(items.filter((_, at) => at !== index))}
                    >
                      <X size={16} aria-hidden="true" />
                    </IconButton>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {disabled ? null : full ? (
        <p className="text-xs text-fg-3">{t("appSettings.listFull", { max: maxItems ?? 0 })}</p>
      ) : (
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label={t("appSettings.listNew", { setting: label })}
            value={draft}
            maxLength={maxLength}
            enterKeyHint="enter"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={addOnEnter}
          />
          <Button onClick={add} disabled={draft.trim() === ""}>
            {t("appSettings.listAdd")}
          </Button>
        </div>
      )}
    </div>
  );
}
