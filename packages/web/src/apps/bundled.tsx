/**
 * The mini-apps this build of the web app holds.
 *
 * The build writes the list (registry.generated.js) and main.tsx hands it
 * to `BundledAppsProvider`; nothing else imports it, so tests and stories
 * supply their own. Which of these apps a person sees is not decided here:
 * that is the session, which lists the apps the server lets them use.
 *
 * Nothing reads the list yet. The dashboard still draws its cards from the
 * session alone; drawing each app's own widget from here is the next step
 * of docs/mini-app-contract.md.
 */
import type { Manifest } from "@hearth/sdk";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

/** A part of an app that is fetched only when it is first drawn. */
export type LazyComponent = () => Promise<{ default: ComponentType }>;

/** One app as the build hands it to the web app. */
export type BundledApp = {
  /** The name of the app's folder, equal to `manifest.id`. */
  id: string;
  /** The default export of the app's `manifest.ts`. */
  manifest: Manifest;
  /** Whether the app has a `page.tsx`. */
  hasPage: boolean;
  /** The app's `widget.tsx`: the body of its card on the dashboard. */
  widget: LazyComponent;
  /** The app's `page.tsx`, when it has one. */
  page?: LazyComponent;
};

const BundledAppsContext = createContext<readonly BundledApp[]>([]);

export function BundledAppsProvider({ apps, children }: { apps: readonly BundledApp[]; children: ReactNode }) {
  return <BundledAppsContext value={apps}>{children}</BundledAppsContext>;
}

/** Every app this build holds. Empty outside a provider. */
export function useBundledApps(): readonly BundledApp[] {
  return useContext(BundledAppsContext);
}
