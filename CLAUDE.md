# BullMQ Visualizer — project instructions

This directory is NOT part of the book repo in the parent folder. Ignore the book
instructions (voice, chapters, YODA) when working here.

## What this is
Self-hosted dashboard for BullMQ and BullMQ Pro. Metabase model: free edition does
everything bull-board does; Pro (USD 49, one-time, offline Ed25519 license) unlocks
Alerts, Users & roles, Folders, Flows. A public live demo runs in `DEMO_MODE=true`
against the simulator.

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

## Commands
- `pnpm install` · `pnpm dev` (server :3000 + web :5173) · `pnpm dev:simulator`
- `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm demo` → docker compose demo (app + mysql + redis + simulator)
- Dev Pro key: `pnpm --filter @bullmq-visualizer/server exec tsx scripts/print-dev-license.ts`
