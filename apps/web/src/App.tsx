import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PageSpinner } from "@/components/ui/Spinner";
import { isApiError } from "@/api/client";
import { SHOW_FLOWS } from "@/lib/featureFlags";
import { AuthProvider } from "@/auth/AuthProvider";
import { RedirectIfAuthed, RequireAuth } from "@/auth/guards";
import { UpsellDialog } from "@/edition/UpsellDialog";
import { Toaster } from "@/components/Toast";
import { AppShell } from "@/components/layout/AppShell";
import { LoginPage } from "@/pages/auth/LoginPage";
import { SetupPage } from "@/pages/auth/SetupPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { ConnectionPage } from "@/pages/ConnectionPage";
import { HealthPage } from "@/pages/HealthPage";
import { QueuePage } from "@/pages/queue/QueuePage";
import { JobPage } from "@/pages/queue/JobPage";
import { GroupJobsPage, GroupsPage } from "@/pages/queue/GroupsPage";
import { FoldersPage } from "@/pages/FoldersPage";
import { FolderPage } from "@/pages/folders/FolderPage";
import { AlertsPage } from "@/pages/alerts/AlertsPage";
import { UsersPage } from "@/pages/UsersPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { NotFoundPage } from "@/pages/NotFoundPage";

// The flow graph pulls in @xyflow/react (~250 KB). Free-edition users never
// open it, so keep it out of the main chunk.
const FlowsPage = lazy(() => import("@/pages/flows/FlowsPage").then((m) => ({ default: m.FlowsPage })));
const FlowsIndexPage = lazy(() => import("@/pages/flows/FlowsPage").then((m) => ({ default: m.FlowsIndexPage })));

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageSpinner />}>{children}</Suspense>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx answers are final; only retry network / 5xx a little.
      retry: (count, err) => {
        if (isApiError(err) && err.status > 0 && err.status < 500) return false;
        return count < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 1_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
    },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route
              path="/login"
              element={
                <RedirectIfAuthed>
                  <LoginPage />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/setup"
              element={
                <RedirectIfAuthed>
                  <SetupPage />
                </RedirectIfAuthed>
              }
            />
            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route index element={<OverviewPage />} />
                <Route path="c/:connectionId" element={<ConnectionPage />} />
                <Route path="c/:connectionId/q/:queue" element={<QueuePage />} />
                <Route path="c/:connectionId/q/:queue/metrics" element={<QueuePage view="metrics" />} />
                <Route path="c/:connectionId/q/:queue/groups" element={<GroupsPage />} />
                <Route path="c/:connectionId/q/:queue/groups/:groupId" element={<GroupJobsPage />} />
                <Route path="c/:connectionId/q/:queue/j/:jobId" element={<JobPage />} />
                <Route path="health" element={<HealthPage />} />
                <Route path="folders" element={<FoldersPage />} />
                <Route path="folders/:folderId" element={<FolderPage />} />
                <Route path="alerts" element={<AlertsPage />} />
                <Route path="users" element={<UsersPage />} />
                {/* Flows is built and working but hidden for now (lib/featureFlags.ts).
                    While hidden, /flows redirects home instead of 404ing a stale bookmark. */}
                {SHOW_FLOWS ? (
                  <>
                    <Route
                      path="flows"
                      element={
                        <Lazy>
                          <FlowsIndexPage />
                        </Lazy>
                      }
                    />
                    <Route
                      path="flows/:connectionId"
                      element={
                        <Lazy>
                          <FlowsPage />
                        </Lazy>
                      }
                    />
                  </>
                ) : (
                  <Route path="flows/*" element={<Navigate to="/" replace />} />
                )}
                <Route path="settings" element={<Navigate to="/settings/connections" replace />} />
                <Route path="settings/:tab" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Route>
          </Routes>
          <UpsellDialog />
          <Toaster />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
