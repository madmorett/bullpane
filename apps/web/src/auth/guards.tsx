import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { Role } from "@bullpane/shared";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";

/** Wraps the authenticated app. Sends to /setup or /login as appropriate. */
export function RequireAuth() {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoading />;
  if (!user) {
    if (needsSetup) return <Navigate to="/setup" replace />;
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

/** For /login and /setup: already logged in users go home. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageLoading />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(role)) {
    return (
      <EmptyState
        icon={<ShieldAlert />}
        title={`${role === "admin" ? "Admins" : "Operators"} only`}
        description={`Your role does not allow this page. Ask an admin to change your role if you need access.`}
      />
    );
  }
  return <>{children}</>;
}

export function FullPageLoading() {
  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-bg">
      <PageSpinner />
    </div>
  );
}
