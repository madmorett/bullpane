import { useCallback, useMemo } from "react";
import { PRO_FEATURES, PRO_PRICE_USD, type Edition, type ProFeature } from "@bullmq-visualizer/shared";
import { useAuth } from "@/auth/AuthProvider";
import { openUpsell } from "./upsellStore";

export const DEFAULT_EDITION: Edition = {
  tier: "free",
  demo: false,
  features: Object.fromEntries(PRO_FEATURES.map((f) => [f, false])) as Record<ProFeature, boolean>,
  license: null,
  priceUsd: PRO_PRICE_USD,
  checkoutUrl: "",
};

export interface EditionInfo {
  edition: Edition;
  tier: Edition["tier"];
  isPro: boolean;
  demo: boolean;
  priceUsd: number;
  checkoutUrl: string;
  /** true when the feature is unlocked */
  has: (feature: ProFeature) => boolean;
  /** run fn when unlocked, otherwise open the upsell dialog */
  gate: (feature: ProFeature, fn?: () => void) => boolean;
}

export function useEdition(): EditionInfo {
  const { edition } = useAuth();
  const e = edition ?? DEFAULT_EDITION;
  const has = useCallback((f: ProFeature) => !!e.features?.[f], [e]);
  const gate = useCallback(
    (f: ProFeature, fn?: () => void) => {
      if (has(f)) {
        fn?.();
        return true;
      }
      openUpsell(f);
      return false;
    },
    [has],
  );
  return useMemo(
    () => ({
      edition: e,
      tier: e.tier,
      isPro: e.tier === "pro",
      demo: !!e.demo,
      priceUsd: e.priceUsd ?? PRO_PRICE_USD,
      checkoutUrl: e.checkoutUrl ?? "",
      has,
      gate,
    }),
    [e, has, gate],
  );
}
