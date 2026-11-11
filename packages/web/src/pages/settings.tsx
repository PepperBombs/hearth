import { LogOut, Moon, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { LOCALES, THEMES, preferencesPatchSchema, type Locale, type Theme } from "@hearth/shared";
import { Page } from "../components/shell/page";
import { Avatar, Card, CardHeader, Field, Input, Segmented, buttonClass } from "../components/ui";
import type { PlainMessageKey } from "../i18n";
import { HTML_LANG, LOCALE_NAMES } from "../i18n/locale";
import { usePreferences } from "../session/preferences";
import { useSession } from "../session/session";

/** Cloudflare Access ends the session at this address on whatever site it protects. */
const SIGN_OUT_PATH = "/cdn-cgi/access/logout";

const THEME_LABELS: Readonly<Record<Theme, PlainMessageKey>> = {
  light: "settings.themeLight",
  dark: "settings.themeDark",
  system: "settings.themeSystem",
};

export function Settings() {
  const { t } = usePreferences();
  return (
    <Page title={t("settings.title")} note={t("settings.autosave")}>
      <div className="flex max-w-[760px] flex-col gap-4">
        <AppearanceCard />
        <AccountCard />
      </div>
    </Page>
  );
}

function AppearanceCard() {
  const { t, theme, setTheme, locale, setLocale } = usePreferences();
  return (
    <Card>
      <CardHeader icon={<Moon size={16} aria-hidden="true" />} title={t("settings.appearance")} />
      <div className="flex flex-col gap-4">
        <Field label={t("settings.theme")} hint={t("settings.themeHint")}>
          <Segmented<Theme>
            label={t("settings.theme")}
            value={theme}
            onChange={setTheme}
            options={THEMES.map((value) => ({ value, label: t(THEME_LABELS[value]) }))}
          />
        </Field>
        <Field label={t("settings.language")} hint={t("settings.languageHint")}>
          <Segmented<Locale>
            label={t("settings.language")}
            value={locale}
            onChange={setLocale}
            options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value], lang: HTML_LANG[value] }))}
          />
        </Field>
      </div>
    </Card>
  );
}

type NameStatus = "idle" | "saving" | "saved" | "error" | "invalid";

function AccountCard() {
  const { user, version } = useSession();
  const { t, saveName } = usePreferences();
  const [name, setName] = useState(user.name);
  const [status, setStatus] = useState<NameStatus>("idle");

  // Follow the saved name when it changes underneath. It changes only when a
  // save succeeds, so after a failed save the field keeps what was typed and
  // Enter, or leaving the field, sends it again.
  useEffect(() => setName(user.name), [user.name]);

  const commit = async () => {
    const parsed = preferencesPatchSchema.safeParse({ name });
    if (!parsed.success || parsed.data.name === undefined) {
      setStatus("invalid");
      return;
    }
    const next = parsed.data.name;
    setName(next);
    if (next === user.name) {
      setStatus((current) => (current === "invalid" || current === "error" ? "idle" : current));
      return;
    }
    setStatus("saving");
    try {
      await saveName(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void commit();
  };

  const statusText =
    status === "saved"
      ? t("settings.nameSaved")
      : status === "error"
        ? t("settings.nameError")
        : status === "invalid"
          ? t("settings.nameInvalid")
          : "";
  const failed = status === "error" || status === "invalid";

  return (
    <Card>
      <CardHeader icon={<UserRound size={16} aria-hidden="true" />} title={t("settings.account")} />

      <div className="mb-4 flex min-w-0 items-center gap-3">
        <Avatar name={user.name} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="clip font-medium">{user.name}</span>
          <span className="clip text-xs text-fg-3">{user.email}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <form onSubmit={onSubmit} className="contents">
          <Field label={t("settings.name")} hint={t("settings.nameHint")} className="items-stretch">
            {({ id, hintId }) => (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Input
                  id={id}
                  aria-describedby={hintId}
                  aria-invalid={failed || undefined}
                  className="max-w-[320px]"
                  value={name}
                  maxLength={80}
                  autoComplete="name"
                  enterKeyHint="done"
                  onChange={(event) => {
                    setName(event.target.value);
                    setStatus("idle");
                  }}
                  onBlur={() => void commit()}
                />
                <span role="status" className={failed ? "text-xs text-down" : "text-xs text-fg-3"}>
                  {statusText}
                </span>
              </div>
            )}
          </Field>
        </form>

        <dl className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium">{t("settings.email")}</dt>
            <dd className="break-all">{user.email}</dd>
            <dd className="text-xs text-fg-3">{t("settings.emailHint")}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium">{t("settings.version")}</dt>
            <dd className="num font-mono text-sm" data-testid="build-version">
              {version}
            </dd>
            <dd className="text-xs text-fg-3">{t("settings.versionHint")}</dd>
          </div>
        </dl>

        <div className="flex flex-col items-start gap-2 border-t border-line pt-4">
          <h3 className="font-medium">{t("settings.signOutTitle")}</h3>
          <p className="text-fg-2">{t("settings.signOutBody")}</p>
          <a href={SIGN_OUT_PATH} className={buttonClass()}>
            <LogOut size={16} aria-hidden="true" />
            {t("settings.signOut")}
          </a>
        </div>
      </div>
    </Card>
  );
}
