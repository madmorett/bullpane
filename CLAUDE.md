# BullMQ Visualizer — project instructions

This directory is NOT part of the book repo in the parent folder. Ignore the book
instructions (voice, chapters, YODA) when working here.

## What this is
Self-hosted dashboard for BullMQ and BullMQ Pro, sold as **Bullpane** (bullpane.com).
Metabase model: free edition does everything bull-board does; Pro (USD 19/month or
149/year, one installation) unlocks Alerts, Users & roles, Folders, Flows, Audit log.
Pro keys are sold through Polar and activated via the license API in `apps/license-api`
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
- DTOs and zod schemas live in `@bullmq-visualizer/shared`. Do not redefine them.
- Never log job data or Redis URLs with passwords.
- Must keep working with BullMQ Pro (groups/batches). Pro key names live in
  `packages/redis-inspector/src/keys.ts` only.

## Segredos e configuração de clientes

`private/` está no `.gitignore` e é onde vive tudo que é específico de um cliente:
IDs de conta AWS, IPs, endpoints, licenças assinadas. **Nunca** coloque nada disso
em `docs/`, `deploy/` ou `README.md` — o repositório pode virar open source.
O equivalente genérico usa placeholders (`<ACCOUNT_ID>`, `<REGION>`).

Instalação em produção da Monest: `private/monest/INSTALACAO-ATUAL.md`.
Polar (IDs de produto, benefit, checkout link, cupom de teste): `private/bullpane/polar.json`.
Chave privada de licença (backup): `private/bullpane/license-private.pem` — nunca sai daqui.

## Commands
- `pnpm install` · `pnpm dev` (server :3000 + web :5173) · `pnpm dev:simulator`
- `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm demo` → docker compose demo (app + mysql + redis + simulator)
- Dev Pro key: `pnpm --filter @bullmq-visualizer/server exec tsx scripts/print-dev-license.ts`
