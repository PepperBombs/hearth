/**
 * Full-page screens shown instead of the shell while there is no session:
 * loading, "not a member yet", and a general failure with a way to try again.
 * They use the language remembered on this device, or the browser's.
 */
import { CircleAlert, RefreshCw, UserRoundX } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button, EmptyState, buttonClass } from "@hearth/sdk/web";
import { BrandMark } from "../components/app-icon";
import { Card } from "../components/card";
import type { PlainMessageKey } from "../i18n";
import { HTML_LANG, LOCALE_NAMES, otherLocale } from "../i18n/locale";
import { usePreferences } from "../session/preferences";
import type { FailureCode } from "../session/api";

const SIGN_OUT_PATH = "/cdn-cgi/access/logout";

function Screen({ title, children }: { title: string; children: ReactNode }) {
  const { locale, toggleLocale, t } = usePreferences();
  const next = otherLocale(locale);

  useEffect(() => {
    document.title = `${title} · Hearth`;
  }, [title]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas p-4 text-fg">
      <div className="flex items-center gap-2 text-md font-semibold">
        <BrandMark className="text-accent" />
        <span>Hearth</span>
      </div>
      <Card className="w-full max-w-[480px]">{children}</Card>
      <button type="button" onClick={toggleLocale} className="rounded-ctl px-2 py-1 text-xs text-fg-3 hover:text-fg max-md:min-h-11">
        <span className="sr-only">{t("nav.switchLanguage")}: </span>
        <span lang={HTML_LANG[next]}>{LOCALE_NAMES[next]}</span>
      </button>
    </main>
  );
}

export function LoadingScreen() {
  const { t } = usePreferences();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas text-fg" aria-busy="true">
      <div role="status" className="flex items-center gap-2 text-md font-semibold">
        <BrandMark className="text-accent motion-safe:animate-[hearth-pulse_1.6s_ease-in-out_infinite]" />
        <span aria-hidden="true">Hearth</span>
        <span className="sr-only">{t("app.loading")}</span>
      </div>
    </main>
  );
}

/** The person is signed in, but nobody has invited them to this Hearth. */
export function NotMemberScreen({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = usePreferences();
  return (
    <Screen title={t("notMember.title")}>
      <EmptyState
        level={1}
        icon={<UserRoundX size={20} />}
        title={t("notMember.title")}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onRetry} disabled={retrying}>
              <RefreshCw size={16} aria-hidden="true" />
              {t("notMember.retry")}
            </Button>
            <a href={SIGN_OUT_PATH} className={buttonClass()}>
              {t("notMember.signOut")}
            </a>
          </div>
        }
      >
        {t("notMember.body")}
      </EmptyState>
    </Screen>
  );
}

const EXPLANATIONS: Readonly<Partial<Record<FailureCode, PlainMessageKey>>> = {
  network: "error.network",
  unauthenticated: "error.unauthenticated",
  invalid_response: "error.invalid",
};

/** Anything else that stops the session from loading. */
export function ErrorScreen({ code, onRetry, retrying }: { code: FailureCode; onRetry: () => void; retrying: boolean }) {
  const { t } = usePreferences();
  return (
    <Screen title={t("error.title")}>
      <EmptyState
        level={1}
        icon={<CircleAlert size={20} />}
        title={t("error.title")}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onRetry} disabled={retrying}>
              <RefreshCw size={16} aria-hidden="true" />
              {t("error.retry")}
            </Button>
            <Button onClick={() => window.location.reload()}>{t("error.reload")}</Button>
          </div>
        }
      >
        {t(EXPLANATIONS[code] ?? "error.server")}
        <span className="mt-2 block text-xs text-fg-3">{t("error.details", { code })}</span>
      </EmptyState>
    </Screen>
  );
}
