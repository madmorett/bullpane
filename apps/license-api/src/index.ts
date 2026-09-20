import { CreemClient } from "./creem";
import type { Env } from "./env";
import { type Deps, handle } from "./handler";
import { importPrivateKey } from "./sign";

let cachedKey: Promise<CryptoKey> | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.LICENSE_PRIVATE_KEY_PEM || !env.CREEM_API_KEY) {
      return new Response(JSON.stringify({ error: "upstream_unavailable", message: "License API is not configured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    cachedKey ??= importPrivateKey(env.LICENSE_PRIVATE_KEY_PEM);
    const deps: Deps = {
      store: new CreemClient({
        base: (env.CREEM_API_BASE ?? "https://api.creem.io").replace(/\/+$/, ""),
        apiKey: env.CREEM_API_KEY,
        // Bound: a detached `fetch` throws "Illegal invocation" in the Workers runtime.
        fetchImpl: (input, init) => fetch(input, init),
      }),
      now: () => Date.now(),
      privateKey: await cachedKey,
      leaseDays: Math.max(1, Number.parseInt(env.LEASE_DAYS ?? "7", 10) || 7),
    };
    return handle(request, deps);
  },
} satisfies ExportedHandler<Env>;
