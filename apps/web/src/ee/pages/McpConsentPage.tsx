import { useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Bot, TriangleAlert } from "lucide-react";
import type { McpGrantAccess } from "@bullpane/shared";
import { useMcpConsent, useMcpConsentDecision } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { AuthLayout } from "@/pages/auth/AuthLayout";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

/**
 * Where /oauth/authorize sends the browser. Two jobs:
 *  - show an authorize error that must not go back to an unverified client (`?error=`);
 *  - ask the signed-in user whether this MCP client may act as them, and how much.
 *
 * Outside the app shell and before the auth guard on purpose: the error case must
 * render for someone who is not signed in, and the sign-in case sends them to
 * /login and back here with the request intact.
 */
export function McpConsentPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const { user, loading } = useAuth();
  const error = params.get("error");
  const request = params.get("request");

  if (error || !request) {
    return (
      <AuthLayout title="Could not connect to Bullpane">
        <p className="flex gap-2 text-sm text-fg">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          {error ?? "This page needs a sign-in request from an MCP client. Start the connection again from Claude."}
        </p>
      </AuthLayout>
    );
  }
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Consent request={request} />;
}

function Consent({ request }: { request: string }) {
  const { user } = useAuth();
  const info = useMcpConsent(request);
  const decide = useMcpConsentDecision();
  const [picked, setPicked] = useState<McpGrantAccess | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (info.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (info.isError || !info.data) {
    return (
      <AuthLayout title="Could not connect to Bullpane">
        <p className="text-sm text-fg">{errorMessage(info.error, "This sign-in request is no longer valid. Start the connection again from Claude.")}</p>
      </AuthLayout>
    );
  }

  const { clientName, redirectHost, allowed, requested, maxAccess } = info.data;
  const access: McpGrantAccess = picked ?? (allowed === "write" && requested === "write" ? "write" : "read");
  const writeBlockedBy = allowed === "write" ? null : maxAccess !== "write" ? "an admin limited MCP to read only" : `your role is ${user?.role}`;

  const answer = (approve: boolean) => {
    setFailed(null);
    decide.mutate(
      { request, approve, access },
      {
        onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
        onError: (err) => setFailed(errorMessage(err)),
      },
    );
  };

  if (allowed === "off") {
    return (
      <AuthLayout title="MCP is turned off">
        <p className="text-sm text-fg-muted">
          An admin has to allow MCP clients in <span className="text-fg">Settings → MCP</span> before {clientName} can connect.
        </p>
        <Button className="mt-5 w-full" variant="secondary" loading={decide.isPending} onClick={() => answer(false)}>
          Back to {clientName}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={`Connect ${clientName} to Bullpane`}
      description={
        <>
          It will act as <span className="text-fg">{user?.email}</span> ({user?.role}) and send you back to {redirectHost}.
        </>
      }
    >
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Access">
        <Option
          selected={access === "read"}
          onSelect={() => setPicked("read")}
          title="Read only"
          detail="See connections, queues, jobs, logs and schedulers."
        />
        <Option
          selected={access === "write"}
          disabled={allowed !== "write"}
          onSelect={() => setPicked("write")}
          title="Read & write"
          detail={writeBlockedBy ? `Not available: ${writeBlockedBy}.` : "Also retry, promote, remove and add jobs, pause and resume queues."}
        />
      </div>
      <p className="mt-3 flex gap-1.5 text-[11px] text-fg-subtle">
        <Bot className="size-3.5 shrink-0" />
        Every change is in the audit log. Drain, clean and obliterate always need you in the dashboard. Disconnect any time in Settings → MCP.
      </p>
      {failed && <p className="mt-3 text-xs text-danger">{failed}</p>}
      <div className="mt-5 flex gap-2">
        <Button className="flex-1" variant="ghost" disabled={decide.isPending} onClick={() => answer(false)}>
          Cancel
        </Button>
        <Button className="flex-1" variant="primary" loading={decide.isPending} onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </AuthLayout>
  );
}

function Option({ selected, disabled, onSelect, title, detail }: { selected: boolean; disabled?: boolean; onSelect: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-accent bg-accent/10" : "border-border bg-surface-2 hover:border-border-strong",
      )}
    >
      <span className="block text-sm font-medium text-fg">{title}</span>
      <span className="mt-0.5 block text-xs text-fg-muted">{detail}</span>
    </button>
  );
}
