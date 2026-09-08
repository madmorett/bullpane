# Bullpane — project instructions

This directory is NOT part of the book repo in the parent folder. Ignore the book
instructions (voice, chapters, YODA) when working here.

## What this is
Self-hosted dashboard for BullMQ and BullMQ Pro, sold as **Bullpane** (bullpane.com).
Metabase model: free edition does everything bull-board does and has NO login at all;
Pro (USD 39/month or 390/year, one installation) unlocks Alerts, Users & roles, Folders,
Flows, Audit log and SSO.
Pro keys are sold through Creem and activated via the license API in `apps/license-api`
(Cloudflare Worker, api.bullpane.com) which signs 7-day Ed25519 leases; hand-signed
offline keys still exist for air-gapped customers. A public live demo runs in
`DEMO_MODE=true` against the simulator. Website: `apps/website` (bullpane.com).

Read `docs/ARCHITECTURE.md` and `docs/API.md` before changing anything. The shared
contract lives in `packages/shared/src/index.ts`; the Redis contract in
`packages/redis-inspector/src/types.ts`.

## Non-negotiables
- **Performance is king.** No `KEYS`. No unbounded scans. One round trip per read
  (Lua via EVALSHA, pipelined per queue). Truncate payloads inside Lua. Writes go
  through the official `bullmq` API. Every new Redis access must be justified in
  a comment and touch keys of a single queue (cluster safe).
- Pro features are gated in exactly two places: `requireFeature()` on the server
  (HTTP 402 `pro_required`) and `useEdition()` on the web. Never hide a Pro feature;
  show it locked with the upsell.
- DTOs and zod schemas live in `@bullpane/shared`. Do not redefine them.
- Never log job data or Redis URLs with passwords.
- Must keep working with BullMQ Pro (groups/batches). Pro key names live in
  `packages/redis-inspector/src/keys.ts` only.

## Language

**English only, everywhere.** Docs, code comments, test names, commit messages,
filenames. The repo may become open source and is part of how the product is
judged; Portuguese content means a rewrite later. `private/` is exempt — it is
gitignored and never ships.

## Secrets and customer configuration

`private/` is gitignored and holds everything specific to one customer: AWS
account ids, IPs, endpoints, signed licenses. **Never** put any of that in
`docs/`, `deploy/` or `README.md` — the repository may become open source. The
generic equivalent uses placeholders (`<ACCOUNT_ID>`, `<REGION>`).

Files that live there: the production install notes for the first customer,
`private/bullpane/creem.json` (product ids, payment links, test coupon), and
`private/bullpane/license-private.pem` (license signing key — never leaves that
directory). Polar was dropped because it does not pay out in Brazil;
`private/bullpane/polar.json` is history only.

## Commands
- `pnpm install` · `pnpm dev` (server :3000 + web :5173) · `pnpm dev:simulator`
- `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm demo` → docker compose demo (app + mysql + redis + simulator)
- Dev Pro key: `pnpm --filter @bullpane/server exec tsx scripts/print-dev-license.ts`
