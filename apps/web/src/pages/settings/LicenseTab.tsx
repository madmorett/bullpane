import { useState } from "react";
import { Check, ExternalLink, KeyRound, Lock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { PRO_FEATURES, type LicenseInfo, type LicenseStatus } from "@bullpane/shared";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { useRefreshLicense, useRemoveLicense, useSetLicense } from "@/api/hooks";
import { errorMessage, isApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { FEATURE_COPY } from "@/edition/featureCopy";
import { EditionPill } from "@/edition/ProBadge";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const STATUS: Record<LicenseStatus, { label: string; variant: BadgeVariant }> = {
  active: { label: "active", variant: "success" },
  grace: { label: "grace period", variant: "warning" },
  expired: { label: "expired", variant: "danger" },
  invalid: { label: "invalid", variant: "danger" },
};

/** One sentence the admin can act on, per status. */
function statusHint(lic: LicenseInfo): string | null {
  if (lic.source === "offline") {
    if (lic.status === "expired") return "This offline key has expired. Ask for a renewed key or activate a subscription key.";
    if (lic.status === "invalid") return "This key does not verify against this build. Paste it again or ask for a new one.";
    return null;
  }
  switch (lic.status) {
    case "grace":
      return `bullpane.com could not be reached (${lic.lastCheckError ?? "unknown error"}). Pro keeps working until ${formatDateTime(lic.leaseExpiresAt)}; the server retries once a day, or check now.`;
    case "expired":
      return lic.lastCheckError
        ? `${lic.lastCheckError} Renew the subscription on bullpane.com, then check again.`
        : "The lease ran out without reaching bullpane.com. Restore the connection and check now.";
    case "invalid":
      return lic.lastCheckError ?? "The store rejected this key.";
    default:
      return null;
  }
}

export function LicenseTab() {
  const { isAdmin, setEdition } = useAuth();
  const { edition, isPro, demo, pricing, checkoutUrl, has } = useEdition();
  const setLicense = useSetLicense();
  const removeLicense = useRemoveLicense();
  const refreshLicense = useRefreshLicense();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const activate = () => {
    const k = key.trim();
    if (!k) {
      setError("Paste the license key");
      return;
    }
    setError(null);
    setLicense.mutate(k, {
      onSuccess: (e) => {
        setEdition(e);
        setKey("");
        toast.success("Pro unlocked", e.license ? `Licensed to ${e.license.licensee}` : undefined);
      },
      onError: (e) => {
        if (isApiError(e) && (e.body.error === "invalid_license" || e.body.error === "license_already_activated" || e.body.error === "license_server_unavailable")) {
          setError(e.body.message || "This key is not valid");
        } else setError(errorMessage(e));
      },
    });
  };

  const checkNow = () =>
    refreshLicense.mutate(undefined, {
      onSuccess: (e) => {
        setEdition(e);
        const st = e.license?.status;
        if (st === "active") toast.success("License verified", `Lease renewed until ${formatDateTime(e.license?.leaseExpiresAt)}`);
        else if (st === "grace") toast.error("Could not reach bullpane.com", e.license?.lastCheckError ?? undefined);
        else toast.error("License not valid", e.license?.lastCheckError ?? undefined);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const lic = edition.license;
  const hint = lic ? statusHint(lic) : null;
  const online = lic?.source === "online";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-surface-2">{isPro ? <ShieldCheck className="size-5 text-pro" /> : <Lock className="size-5 text-fg-subtle" />}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{demo ? "Demo mode" : isPro ? "Pro edition" : "Free edition"}</h2>
                <EditionPill />
              </div>
              <p className="text-xs text-fg-muted">
                {demo
                  ? "Every Pro feature is unlocked for the playground. Settings that could break the demo are read-only."
                  : isPro
                    ? "All features unlocked for this installation."
                    : "Everything bull-board does, plus search. Team features need a Pro key."}
              </p>
            </div>
            {online && isAdmin && !demo && (
              <Button variant="outline" size="sm" leftIcon={<RefreshCw />} onClick={checkNow} loading={refreshLicense.isPending}>
                Check now
              </Button>
            )}
          </div>

          {lic && (
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Licensee</dt>
                <dd className="truncate text-fg">{lic.licensee}</dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Email</dt>
                <dd className="truncate text-fg">{lic.email}</dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{online ? "Plan" : "Issued"}</dt>
                <dd className="text-fg">{online ? "Subscription" : formatDate(lic.issuedAt)}</dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{online ? "Paid until" : "Expires"}</dt>
                <dd className="text-fg">
                  {lic.expiresAt ? formatDate(lic.expiresAt) : online ? "Renews automatically" : "Never"}{" "}
                  <Badge variant={STATUS[lic.status].variant} size="xs" className="ml-1">
                    {STATUS[lic.status].label}
                  </Badge>
                </dd>
              </div>
              {online && (
                <>
                  <div>
                    <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Last verified</dt>
                    <dd className="text-fg" title={lic.lastCheckedAt ? formatDateTime(lic.lastCheckedAt) : undefined}>
                      {lic.lastCheckedAt ? formatRelative(lic.lastCheckedAt) : "never"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Works offline until</dt>
                    <dd className="text-fg">{formatDateTime(lic.leaseExpiresAt)}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Activation</dt>
                    <dd className="truncate font-mono text-fg">{lic.activationId}</dd>
                  </div>
                </>
              )}
            </dl>
          )}

          {hint && (
            <p className={`mt-3 rounded-md border px-3 py-2 text-xs ${lic?.status === "grace" ? "border-warning/40 bg-warning/10 text-warning" : "border-danger/40 bg-danger/10 text-danger"}`}>
              {hint}
            </p>
          )}

          {demo && <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">Demo mode notice: license changes are blocked here. Run your own instance to activate a key.</p>}
        </div>

        <div className="card p-4">
          <h3 className="mb-3 text-xs font-semibold tracking-wider text-fg-subtle uppercase">Features</h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {PRO_FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs">
                {has(f) ? <Check className="mt-px size-4 shrink-0 text-success" /> : <Lock className="mt-px size-4 shrink-0 text-fg-subtle" />}
                <div>
                  <p className="font-medium text-fg">{FEATURE_COPY[f].title}</p>
                  <p className="text-fg-muted">{FEATURE_COPY[f].tagline}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="space-y-4">
        {isAdmin ? (
          <div className="card p-4">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="size-4" /> {isPro && !demo ? "Replace license key" : "Activate a license key"}
            </h3>
            <p className="mb-3 text-xs text-fg-muted">
              Paste the key from your bullpane.com receipt. One key runs one installation: it is activated once against bullpane.com, re-checked
              daily, and keeps working for 7 days without internet. Nothing about your queues or jobs is sent.
            </p>
            <Textarea mono rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder="BULLPANE-XXXX-XXXX-XXXX" error={error} spellCheck={false} disabled={demo} aria-label="License key" />
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={activate} loading={setLicense.isPending} disabled={demo}>
                Activate
              </Button>
              {lic && !demo && (
                <Button variant="ghost" size="sm" className="hover:text-danger" leftIcon={<Trash2 />} onClick={() => setConfirmRemove(true)}>
                  Remove license
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="card p-4 text-xs text-fg-muted">Only admins can change the license.</div>
        )}

        {!isPro && (
          <div className="card border-pro/30 p-4">
            <p className="text-sm font-semibold">
              Unlock Pro · ${pricing.monthlyUsd}/month or ${pricing.yearlyUsd}/year
            </p>
            <p className="mt-1 text-xs text-fg-muted">One installation, unlimited connections, queues and users. Cancel any time; your data stays.</p>
            <a
              href={checkoutUrl || "#"}
              target="_blank"
              rel="noreferrer noopener"
              aria-disabled={!checkoutUrl}
              className="mt-3 inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              Get a key <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove license"
        description={
          online
            ? "The installation goes back to the free edition, which has NO LOGIN: anyone who can reach this URL will be able to retry, promote and delete jobs. The key is released so it can be activated on another server. Alerts, folders, flow edges and your user accounts are kept in the database but become inaccessible until a key is activated again."
            : "The installation goes back to the free edition, which has NO LOGIN: anyone who can reach this URL will be able to retry, promote and delete jobs. Alerts, folders, flow edges and your user accounts are kept in the database but become inaccessible until a key is activated again."
        }
        confirmText="Remove license"
        danger
        loading={removeLicense.isPending}
        onConfirm={() =>
          removeLicense.mutate(undefined, {
            onSuccess: (e) => {
              setEdition(e);
              setConfirmRemove(false);
              toast.success("License removed");
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </div>
  );
}
