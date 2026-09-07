import { Link } from "react-router-dom";
import { Check, ExternalLink, KeyRound, Sparkles } from "lucide-react";
import { PRO_FEATURES } from "@bullpane/shared";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { FEATURE_COPY } from "./featureCopy";
import { closeUpsell, useUpsellState } from "./upsellStore";
import { useEdition } from "./useEdition";

export function UpsellDialog() {
  const { open, feature } = useUpsellState();
  const { pricing, checkoutUrl, demo } = useEdition();
  const copy = FEATURE_COPY[feature];

  return (
    <Dialog
      open={open}
      onClose={closeUpsell}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-pro" aria-hidden />
          {copy.title} is a Pro feature
        </span>
      }
      description={copy.tagline}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={closeUpsell}>
            Not now
          </Button>
          <Link
            to="/settings/license"
            onClick={closeUpsell}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
          >
            <KeyRound className="size-3.5" aria-hidden />I have a key
          </Link>
          <a
            href={checkoutUrl || "#"}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={!checkoutUrl}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-hover aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            Unlock Pro · ${pricing.monthlyUsd}/mo or ${pricing.yearlyUsd}/yr
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </>
      }
    >
      <ul className="space-y-2">
        {copy.bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-[13px] text-fg">
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-md border border-border bg-surface-2/60 p-3 text-xs text-fg-muted">
        <p>
          One subscription unlocks every Pro feature — {PRO_FEATURES.map((f) => FEATURE_COPY[f].title).join(", ")} — for
          this installation. ${pricing.monthlyUsd}/month or ${pricing.yearlyUsd}/year, unlimited users. Your data stays on your
          servers; only the key is verified with bullpane.com.
        </p>
        {demo && <p className="mt-2 text-warning">You are in demo mode: Pro is already unlocked here.</p>}
      </div>
    </Dialog>
  );
}
