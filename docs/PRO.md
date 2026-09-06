# Pro edition, licensing and demo mode

The Pro edition is the same binary as the free edition. A license key unlocks
`alerts`, `users`, `folders` and `flows` (see the editions table in
`ARCHITECTURE.md`). USD 49, one-time, per installation, no seats.

## License format

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
- The signature is Ed25519 over the **base64url payload string** (not the raw
  JSON): `crypto.sign(null, Buffer.from(payloadB64url), privateKey)`.
- Verification is `crypto.verify(null, Buffer.from(payloadB64url), publicKey, sig)`
  with the public key compiled into the server as `LICENSE_PUBLIC_KEY_B64`
  (base64 of the SPKI DER).

Validation is fully offline. The server never contacts a license server, never
reports usage, and works air-gapped. A key that fails to verify, or whose
`expiresAt` is in the past, leaves the installation on the free tier with a
clear message in Settings → License.

## Issuing keys (vendor side)

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

1. Buy at the checkout URL (`BMV_CHECKOUT_URL`, shown on the "Unlock Pro" button).
2. Paste the key in **Settings → License**, or set `BMV_LICENSE_KEY` in the
   environment (the env var wins over the database on boot).
3. The `Edition` returned by `/api/edition` flips to `tier: "pro"` and every
   402 `pro_required` route opens up. No restart needed when set via the UI.

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
