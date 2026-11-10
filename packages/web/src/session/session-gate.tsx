import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { ErrorScreen, LoadingScreen, NotMemberScreen } from "../pages/gate-screens";
import { ApiRequestError, failureCode, fetchSession } from "./api";
import { usePreferences } from "./preferences";
import { SESSION_QUERY_KEY, SessionContext } from "./session";

/** Server errors and dropped connections are worth another go; "you may not" is not. */
function worthRetrying(failures: number, error: unknown): boolean {
  if (failures >= 2) return false;
  if (!(error instanceof ApiRequestError)) return false;
  return error.code === "network" || error.status >= 500;
}

/**
 * Loads GET /api/session once and provides it to everything inside.
 * Until it has loaded, shows a loading, "not a member yet" or error screen instead.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { adopt } = usePreferences();
  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: worthRetrying,
    retryDelay: 600,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // The server's stored theme and language win over what this browser remembered.
  const theme = query.data?.user.theme;
  const locale = query.data?.user.locale;
  useEffect(() => {
    if (theme && locale) adopt({ theme, locale });
  }, [theme, locale, adopt]);

  if (query.data) return <SessionContext value={query.data}>{children}</SessionContext>;
  if (query.isPending) return <LoadingScreen />;

  const retry = () => void query.refetch();
  const code = failureCode(query.error);
  if (code === "not_a_member") return <NotMemberScreen onRetry={retry} retrying={query.isFetching} />;
  return <ErrorScreen code={code} onRetry={retry} retrying={query.isFetching} />;
}
