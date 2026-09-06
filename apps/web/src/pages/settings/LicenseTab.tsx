import { useState } from "react";
import { Check, ExternalLink, KeyRound, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { PRO_FEATURES } from "@bullmq-visualizer/shared";
import { formatDate } from "@/lib/format";
import { useRemoveLicense, useSetLicense } from "@/api/hooks";
import { errorMessage, isApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useEdition } from "@/edition/useEdition";
import { FEATURE_COPY } from "@/edition/featureCopy";
import { EditionPill } from "@/edition/ProBadge";
import { toast } from "@/components/Toast";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function LicenseTab() {
  const { isAdmin, setEdition } = useAuth();
  const { edition, isPro, demo, priceUsd, checkoutUrl, has } = useEdition();
  const setLicense = useSetLicense();
  const removeLicense = useRemoveLicense();
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
        if (isApiError(e) && e.body.error === "invalid_license") setError(e.body.message || "This key is not valid");
        else setError(errorMessage(e));
      },
    });
  };

  const lic = edition.license;

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
                <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Issued</dt>
                <dd className="text-fg">{formatDate(lic.issuedAt)}</dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">Expires</dt>
                <dd className="text-fg">
                  {lic.expiresAt ? formatDate(lic.expiresAt) : "Never"}{" "}
                  <Badge variant={lic.valid ? "success" : "danger"} size="xs" className="ml-1">
                    {lic.valid ? "valid" : "invalid"}
                  </Badge>
                </dd>
              </div>
            </dl>
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
            <p className="mb-3 text-xs text-fg-muted">Keys are Ed25519-signed and verified offline. Nothing is sent anywhere.</p>
            <Textarea mono rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder="eyJsaWNlbnNlZSI6…" error={error} spellCheck={false} disabled={demo} aria-label="License key" />
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={activate} loading={setLicense.isPending} disabled={demo}>
                Activate
              </Button>
              {isPro && lic && !demo && (
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
            <p className="text-sm font-semibold">Unlock Pro · ${priceUsd} one-time</p>
            <p className="mt-1 text-xs text-fg-muted">Perpetual license for this installation. No subscription, no seat count, no phone-home.</p>
            <a
              href={checkoutUrl || "#"}
              target="_blank"
              rel="noreferrer noopener"
              aria-disabled={!checkoutUrl}
              className="mt-3 inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              Buy a key <ExternalLink className="size-3.5" />
            </a>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove license"
        description="The installation goes back to the free edition. Alerts, folders, flow edges and extra users are kept in the database but become inaccessible until a key is activated again."
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
