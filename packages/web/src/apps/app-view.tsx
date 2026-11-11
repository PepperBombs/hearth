/**
 * `<AppView>` draws one part of a mini-app, its widget or its page, and
 * everything the app's own code does not have to: the skeleton while its
 * code and its first answers are on their way, the failed state with a way
 * to try again, the notice when a change could not be saved, and "Reload to
 * update" when this browser holds an older build than the server.
 *
 * The card around a widget (icon, name, the space's tag, the link to the
 * page) and the top bar of a page are drawn by the screens that use this.
 */
import type { AppSummary } from "@hearth/shared";
import { Button } from "@hearth/sdk/web";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, TriangleAlert } from "lucide-react";
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { reloadPage } from "../lib/reload";
import type { FailureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { appPath } from "../session/session";
import { useBundledApps, type BundledApp, type LazyComponent } from "./bundled";
import { AppScope, installQueryKey } from "./scope";

/** The app's code could not be fetched: most likely the server has a newer build than this page. */
class AppCodeError extends Error {
  constructor(cause: unknown) {
    super("The app's code could not be loaded.", { cause });
    this.name = "AppCodeError";
  }
}

const components = new WeakMap<LazyComponent, LazyExoticComponent<ComponentType>>();

/**
 * The component behind one of the build's `() => import(...)`, made once.
 * The fetch starts here, not when the component is first drawn, so that it
 * runs beside the request for the app's settings and not after it.
 */
function componentFor(load: LazyComponent): LazyExoticComponent<ComponentType> {
  let component = components.get(load);
  if (!component) {
    const loading = Promise.resolve()
      .then(load)
      .catch((error: unknown) => {
        throw new AppCodeError(error);
      });
    loading.catch(() => {});
    component = lazy(() => loading);
    components.set(load, component);
  }
  return component;
}

type BoundaryProps = {
  /** What to show in place of the children once one of them has thrown. */
  fallback: (error: unknown, retry: () => void) => ReactNode;
  /** Called before the children are drawn again. */
  onRetry: () => void;
  children: ReactNode;
};

/** Keeps a fault in one app's code, or a failed first load, inside that app's card. */
class Boundary extends Component<BoundaryProps, { failed: boolean; error: unknown }> {
  override state = { failed: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  retry = () => {
    this.props.onRetry();
    this.setState({ failed: false, error: undefined });
  };

  override render() {
    return this.state.failed ? this.props.fallback(this.state.error, this.retry) : this.props.children;
  }
}

/** Grey bars where the app's content will be. */
function Skeleton() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      data-testid="app-skeleton"
      className="flex flex-1 flex-col gap-3 py-1.5 motion-safe:animate-[hearth-pulse_1.6s_ease-in-out_infinite]"
    >
      <span className="sr-only">{t("appView.loading")}</span>
      <span aria-hidden="true" className="h-3 w-4/5 rounded-full bg-soft" />
      <span aria-hidden="true" className="h-3 w-3/5 rounded-full bg-soft" />
      <span aria-hidden="true" className="h-3 w-2/3 rounded-full bg-soft" />
    </div>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-1 flex-col items-start justify-center gap-2.5 py-1.5">
      <p className="text-fg-2">{t("appView.failed")}</p>
      <Button size="sm" onClick={onRetry}>
        <RefreshCw size={14} aria-hidden="true" />
        {t("appView.retry")}
      </Button>
    </div>
  );
}

/** This browser's copy of Hearth is older than the server's and does not hold (this version of) the app. */
function ReloadToUpdate() {
  const { t } = useI18n();
  return (
    <div role="status" className="flex flex-1 flex-col items-start justify-center gap-2.5 py-1.5">
      <p className="text-fg-2">{t("appView.outdated")}</p>
      <Button size="sm" onClick={reloadPage}>
        <RefreshCw size={14} aria-hidden="true" />
        {t("appView.reload")}
      </Button>
    </div>
  );
}

/**
 * What the notice under an app says about a change that failed. Trying again
 * helps when the server could not be reached or failed itself; it does not
 * when the server turned the change down, so that is not offered then.
 */
function changeFailedMessage(code: FailureCode): "appView.viewOnly" | "appView.changeRefused" | "appView.changeFailed" {
  if (code === "forbidden") return "appView.viewOnly";
  if (code === "invalid_request" || code === "not_found" || code === "conflict") return "appView.changeRefused";
  return "appView.changeFailed";
}

/** A change the person made did not reach the server, or was refused. */
function ChangeFailed({ code }: { code: FailureCode | null }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-live="polite">
      {code === null ? null : (
        <p className="mt-2.5 flex items-start gap-2 rounded-ctl bg-warn px-2.5 py-1.5 text-xs text-warn-fg">
          <TriangleAlert size={14} aria-hidden="true" className="mt-[3px]" />
          <span className="min-w-0">{t(changeFailedMessage(code))}</span>
        </p>
      )}
    </div>
  );
}

export type AppViewProps = {
  /** The app in its space, as the session lists it. */
  app: AppSummary;
  /** Which of the app's two components to draw. */
  part: "widget" | "page";
};

export function AppView({ app, part }: AppViewProps) {
  const bundled = useBundledApps().find((candidate) => candidate.id === app.id);
  const load = part === "widget" ? bundled?.widget : bundled?.page;
  // The session comes from the server and the list of apps from this page's own build, which may be the older one.
  if (!bundled || !load) return <ReloadToUpdate />;
  // Keyed, so that one app's failed state or notice is never shown for another.
  return <Loaded key={`${app.spaceId}/${app.id}/${part}`} app={app} bundled={bundled} load={load} />;
}

function Loaded({ app, bundled, load }: { app: AppSummary; bundled: BundledApp; load: LazyComponent }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<FailureCode | null>(null);
  const Part = componentFor(load);
  const { spaceId, id: appId } = app;

  // A query that failed stays failed until it is asked to start over.
  const startOver = useCallback(() => {
    void client.resetQueries({ queryKey: installQueryKey({ spaceId, appId }) });
  }, [client, spaceId, appId]);

  // An app links to its own page with a plain <a href={pagePath}>. Followed here, the page opens without a reload.
  const page = appPath(app);
  const followOwnLinks = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(link instanceof HTMLAnchorElement) || (link.target !== "" && link.target !== "_self")) return;
    const to = new URL(link.href, window.location.href);
    if (to.origin !== window.location.origin || (to.pathname !== page && !to.pathname.startsWith(`${page}/`))) return;
    event.preventDefault();
    void navigate(`${to.pathname}${to.search}${to.hash}`);
  };

  return (
    // The click is one that an <a> inside already answers to; this only decides how it is followed.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-app-part={bundled.id} onClick={followOwnLinks}>
      <Boundary
        onRetry={startOver}
        fallback={(error, retry) => (error instanceof AppCodeError ? <ReloadToUpdate /> : <Failed onRetry={retry} />)}
      >
        <Suspense fallback={<Skeleton />}>
          <AppScope app={app} manifest={bundled.manifest} onFailure={setFailure}>
            <Part />
          </AppScope>
        </Suspense>
      </Boundary>
      <ChangeFailed code={failure} />
    </div>
  );
}
