# Bullpane operations — website, license API, store

What runs where for the commercial side. Customer-specific secrets live in
`private/` (gitignored); this page holds the generic shape.

| Piece | Where | Source | Deploy |
|---|---|---|---|
| Website bullpane.com (+ www) | Cloudflare Worker, static assets | `apps/website/public` | `pnpm --filter @bullpane/website deploy` |
| License API api.bullpane.com | Cloudflare Worker | `apps/license-api` | `pnpm --filter @bullpane/license-api deploy` |
| Store, checkout, invoices, tax | Creem (merchant of record) | products created via API | `private/bullpane/creem.json` |
| Docker image | ghcr.io/<owner>/bullpane | `Dockerfile` | `.github/workflows/docker.yml` on push / tag |

Both Workers also deploy from GitHub Actions (`deploy-cloudflare.yml`) when their
folders change on `main`; the workflow needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as repository secrets.

## License API secrets

Set once, survive deploys:

```sh
cd apps/license-api
wrangler secret put LICENSE_PRIVATE_KEY_PEM   # contents of keys/license-private.pem
wrangler secret put CREEM_API_KEY             # live key; test mode has its own key + CREEM_API_BASE
```

Optional vars in `wrangler.toml`: `LEASE_DAYS` (7), `CREEM_API_BASE` (https://test-api.creem.io for test mode).

The private key's public half is `LICENSE_PUBLIC_KEY_B64` in
`apps/server/src/license.ts`. Rotating the key invalidates every offline key and
every lease at once; every running installation would drop to free within a day.
Do not lose it: it is in `keys/` and backed up in `private/bullpane/`.

## Creem

Two live products (monthly USD 39, yearly USD 390), each with the License Key
add-on enabled in the dashboard with activation limit 1 (the API cannot set it),
default success URL `https://bullpane.com/thanks`, and a 100%-off discount code
for internal testing. IDs and payment links in `private/bullpane/creem.json`.

Prices are editable in place: `PATCH /v1/products/{id}` with `{"price": <cents>}`
(and `description`), which is how 19/149 became 39/390 on 2026-09-08 while there
were no subscribers. The product ids and payment links survive a price change, so
nothing on the website needs updating — it links to the product urls. **With paying
subscribers this is the wrong move**: patching the price of a product people are
already billed on decides their fate for them. Create new products, archive the old
ones, and let existing subscriptions run at the price they signed up for.
`price_history` in `creem.json` records what changed and when.
The Polar objects created before we learned Polar cannot pay out to Brazil are
left unpublished; `private/bullpane/polar.json` is history only.

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
the Creem dashboard (Products → License keys).
