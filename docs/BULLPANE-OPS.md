# Bullpane operations — website, license API, store

What runs where for the commercial side. Customer-specific secrets live in
`private/` (gitignored); this page holds the generic shape.

| Piece | Where | Source | Deploy |
|---|---|---|---|
| Website bullpane.com (+ www) | Cloudflare Worker, static assets | `apps/website/public` | `pnpm --filter @bullmq-visualizer/website deploy` |
| License API api.bullpane.com | Cloudflare Worker | `apps/license-api` | `pnpm --filter @bullmq-visualizer/license-api deploy` |
| Store, checkout, invoices, tax | Polar (merchant of record) | products created via API | `private/bullpane/polar.json` |
| Docker image | ghcr.io/<owner>/bullpane | `Dockerfile` | `.github/workflows/docker.yml` on push / tag |

Both Workers also deploy from GitHub Actions (`deploy-cloudflare.yml`) when their
folders change on `main`; the workflow needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as repository secrets.

## License API secrets

Set once, survive deploys:

```sh
cd apps/license-api
wrangler secret put LICENSE_PRIVATE_KEY_PEM   # contents of keys/license-private.pem
wrangler secret put POLAR_ORGANIZATION_ID
```

Optional vars in `wrangler.toml`: `LEASE_DAYS` (7), `POLAR_API_BASE`.

The private key's public half is `LICENSE_PUBLIC_KEY_B64` in
`apps/server/src/license.ts`. Rotating the key invalidates every offline key and
every lease at once; every running installation would drop to free within a day.
Do not lose it: it is in `keys/` and backed up in `private/bullpane/`.

## Polar

One organization, one license-key benefit (prefix `BULLPANE`, activation limit 1,
customers may deactivate from their portal), two products that share the benefit
(monthly USD 19, yearly USD 149), one checkout link that offers both, and a
100%-off discount code for internal testing. IDs in `private/bullpane/polar.json`.

Why one benefit and two products: Polar products carry a single billing interval,
and a shared benefit means a key is a key regardless of how it was paid.

## Smoke test after a deploy

```sh
curl https://api.bullpane.com/v1/health
# → {"ok":true}
curl -X POST https://api.bullpane.com/v1/license/activate \
  -H 'content-type: application/json' \
  -d '{"key":"BULLPANE-0000-0000-0000","instance":{"label":"probe"}}'
# → 404 {"error":"license_not_found", ...}
```

Full loop: buy with the test discount code, paste the key in a local dashboard,
check Settings → License shows `active`, remove it, check the activation is gone in
the Polar dashboard.
