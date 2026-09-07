# Pro edition, licensing and demo mode

The Pro edition is the same binary as the free edition. A license key unlocks
`alerts`, `users`, `folders`, `flows` and `audit` (see the editions table in
`ARCHITECTURE.md`). USD 19/month or 149/year, per installation, unlimited users.
Sold on bullpane.com through Polar (merchant of record).

`audit` is the one feature whose data is collected in every edition: the
`onResponse` hook writes rows regardless of the licence, and only reading and
exporting them is gated. Upgrading therefore reveals history that was already
captured instead of starting an empty table. The reasoning for gating it at all
is in `ARCHITECTURE.md`, "Why Pro and not Free".

## Two kinds of key

| | Subscription key | Offline key |
|---|---|---|
| Looks like | `BULLPANE-XXXX-XXXX-XXXX` | `eyJsaWNlbnNlZSI6…​.MEUCIQ…` |
| Issued by | Polar, after checkout on bullpane.com | `scripts/gen-license.ts` by hand |
| Verified by | the license API turns it into a signed **lease**; the server verifies the lease | the server, locally |
| Talks to the internet | api.bullpane.com once on activation, then every 24 h | never |
| Installations | exactly one (activation limit 1; remove to move) | whatever the payload says |
| Ends when | the subscription is cancelled, or the lease runs out after 7 days without contact | `expiresAt`, or never |

The offline key exists for procurement and air-gapped installs. Everything else
is a subscription key.

### Subscription key lifecycle

1. Admin pastes the key in Settings → License (or sets `BULLPANE_LICENSE_KEY`).
2. Server `POST api.bullpane.com/v1/license/activate { key, instance: { label, version } }`.
   The API activates the key at Polar (`label` = hostname + PUBLIC_URL, shown in the
   customer portal) and answers `{ lease }`. Polar refusing because the key is already
   active elsewhere becomes **409 `license_already_activated`** in the dashboard.
3. Server verifies the lease with the compiled-in public key, stores key + activation id
   + lease in `settings`, and is Pro.
4. Every `BULLPANE_LICENSE_REFRESH_HOURS` (24) it calls `/v1/license/refresh { key, activationId }`
   and gets a new 7-day lease. On boot it only re-checks if the last check is older than
   an hour or failed, so restart storms don't hammer the API.
5. Outcomes, visible as `Edition.license.status`:
   * `active` – lease valid, last check fine.
   * `grace` – lease still valid but the API could not be reached. Pro keeps working
     until `leaseExpiresAt` (7 days from the last good check).
   * `expired` – lease ran out with no answer, or the store says the paid period ended.
   * `invalid` – the store says cancelled / not found / the activation was freed from the
     portal. Pro locks immediately, whatever the lease says.
6. Removing the key calls `/v1/license/deactivate` (best effort) so the same key can be
   activated on the next server. Data (alerts, folders, users) stays in the database.

The license API is `apps/license-api`, a Cloudflare Worker. It holds the vendor
private key and the Polar organization id as secrets and uses Polar's unauthenticated
customer-portal license endpoints (`activate`, `validate`, `deactivate`). The dashboard
never sees Polar, and Polar never sees the dashboard's data.

## Token format (offline keys and leases alike)

```
base64url(payloadJson) . base64url(ed25519Signature)
```

Payload is `LicensePayload` from `packages/shared/src/index.ts`:

```json
{
  "licensee": "Acme Inc",
  "email": "ops@acme.io",
  "plan": "pro",
  "issuedAt": 1788700000000,
  "expiresAt": null,
  "notes": "1.x"
}
```

- `issuedAt` / `expiresAt` are unix **milliseconds**; `expiresAt: null` = perpetual.
- Leases add `activationId`, `subscriptionExpiresAt` (end of the paid period, null for an
  open subscription) and `billing: "subscription"`; their `expiresAt` is the lease end.
- The signature is Ed25519 over the **base64url payload string** (not the raw
  JSON): `crypto.sign(null, Buffer.from(payloadB64url), privateKey)`.
- Verification is `crypto.verify(null, Buffer.from(payloadB64url), publicKey, sig)`
  with the public key compiled into the server as `LICENSE_PUBLIC_KEY_B64`
  (base64 of the SPKI DER).

Verification of the token itself is offline in both cases. A token that fails to
verify, or whose `expiresAt` is in the past, leaves the installation on the free
tier with a clear message in Settings → License.

## Issuing offline keys (vendor side)

`scripts/gen-license.ts` uses only `node:crypto` and `node:util`.

```sh
# once: create the keypair. keys/ is gitignored. The private key never leaves
# the vendor machine; the printed base64 goes into the server constant.
pnpm license:keygen
#   private key : keys/license-private.pem
#   public key  : keys/license-public.pem
#   Paste into apps/server (LICENSE_PUBLIC_KEY_B64):
#   MCowBQYDK2VwAyEA...

# per customer
pnpm license:sign -- --licensee "Acme Inc" --email ops@acme.io
pnpm license:sign -- --licensee "Acme Inc" --email ops@acme.io --expires 2027-01-01 --notes "1.x"

# sanity check a key
pnpm tsx scripts/gen-license.ts verify "<key>" --pub keys/license-public.pem
```

`verify` prints the payload plus `valid` / `expired`, or the single word
`invalid` (exit 1) when the signature does not match, and exit 2 when expired.

Rotating the public key invalidates every issued license; treat the private
key like a production secret (offline, backed up, never in CI).

## Activating

1. Buy at the checkout URL (`BULLPANE_CHECKOUT_URL`, shown on the "Unlock Pro" button).
   The key is on the receipt and in the Polar customer portal.
2. Paste the key in **Settings → License**, or set `BULLPANE_LICENSE_KEY` in the
   environment. A key stored through the UI wins over the env var on boot; an env
   key with no stored activation is activated a few seconds after boot.
3. The `Edition` returned by `/api/edition` flips to `tier: "pro"` and every
   402 `pro_required` route opens up. No restart needed when set via the UI.

## Running the license API yourself (development)

```sh
cd apps/license-api
pnpm test                                   # scripted Polar, real Ed25519
wrangler secret put LICENSE_PRIVATE_KEY_PEM  # paste keys/license-private.pem
wrangler secret put POLAR_ORGANIZATION_ID
pnpm dev                                    # http://localhost:8787
# then run the server with BULLPANE_LICENSE_API_URL=http://localhost:8787
```

To test the whole loop without paying, the Polar discount code in
`private/bullpane/polar.json` gives a 100% off subscription and a real key.

## DEMO_MODE

`DEMO_MODE=true` is how the public playground runs (`docker-compose.demo.yml`).
It changes the server in exactly these ways:

- On boot: creates the admin `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` if no
  users exist, and seeds one Redis connection pointing at `DEMO_REDIS_URL`.
- `Edition.demo = true` and all Pro features are enabled without a key. The UI
  shows a "demo" badge where it would show the license.
- Destructive settings changes return `423 demo_locked`: deleting or editing
  the seeded connection, changing the admin password, uploading a license,
  deleting users. Queue operations (retry, promote, drain, obliterate) stay
  enabled — the simulator refills everything within a minute anyway.
- `SetupStatus.demo` is true so the login page can show the credentials.

Do not run `DEMO_MODE=true` for anything real: it hands Pro out for free and
publishes the admin password on the login screen by design.
