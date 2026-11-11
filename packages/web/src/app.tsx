import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Route, Routes } from "react-router";
import { Shell } from "./components/shell/shell";
import { AppPage } from "./pages/app-page";
import { Apps } from "./pages/apps";
import { Dashboard } from "./pages/dashboard";
import { NotFound } from "./pages/not-found";
import { Settings } from "./pages/settings";
import { PreferencesProvider } from "./session/preferences";
import { SessionGate } from "./session/session-gate";

/** Every screen of the shell. Must be rendered inside a router. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="apps" element={<Apps />} />
        <Route path="apps/:spaceId/:appId/*" element={<AppPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/** The whole app, less the router, so tests can supply an in-memory one. */
export function App({ queryClient }: { queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <PreferencesProvider>
        <SessionGate>
          <AppRoutes />
        </SessionGate>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}
