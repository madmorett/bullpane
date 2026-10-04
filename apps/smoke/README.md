# @bullpane/smoke

End-to-end smoke tests. Nothing is mocked: a real Postgres, real BullMQ
workers, the real server (`apps/server`, started the way `pnpm dev` starts it)
and a real browser.

```bash
pnpm smoke:postgres
```

First time only, for the browser part:

```bash
pnpm --filter @bullpane/smoke exec playwright install chromium
```

## What `smoke:postgres` proves

1. **Every feature, over HTTP.** Against a Pro server (a throwaway Ed25519 key
   signs a license on the spot, so no vendor key is needed): creating a
   PostgreSQL connection (wrong password, wrong schema, wrong URL scheme),
   discovery, counts in every state, pagination and order, payload truncation,
   search (payload, error, name, case, `%`/`_`, cursor), job detail, logs, flow
   tree, schedulers, every job action (add, remove, promote, retry, bulk,
   discard over a live worker's lock), every queue action (pause, resume, clean,
   retry-all, drain, hide, obliterate), the health monitor, connection edits,
   and the Pro features (flows, folders, an alert actually firing, a viewer
   refused with 403, the audit trail).
2. **Reading does not slow the workers, and does not lock.** A steady workload
   (20 workers, ~2 000 jobs waiting) runs in its own process while the
   dashboard is used at three intensities, with a 320k-job history to read.
   Throughput is compared against two baselines (before and after, which gives
   the machine's own noise), and a monitor samples `pg_stat_activity` /
   `pg_locks` every 25 ms: while reading, the dashboard must hold nothing but
   `AccessShareLock`, never block a worker, never wait on a lock, never sit
   `idle in transaction`, and never use more than its 4 connections.
3. **The browser journey**: sign in, add the connection through the dialog
   (testing it first), read a queue from the sidebar, search, open a job, remove
   it, pause/resume, retry a failed job, check the health page, delete the
   connection. A screenshot per step.
4. **The free edition**: no login, the same reads and actions, Pro routes
   answer `402 pro_required`.
5. **Where customers run Postgres**, in throwaway Docker containers on a
   private network (skipped without Docker): PgBouncer in transaction mode
   (defaults, and `ignore_startup_parameters=options`), Postgres with TLS and a
   private CA (`sslmode=require`, `verify-full` with the CA, `verify-full`
   without it refused), a read-only role (reads work, actions are a 403), and
   MySQL as the dashboard's own database. Each runs the journey: test and create
   the connection, read, search, remove, add, retry, health.

Typical run: ~3 minutes, ~160 checks.

## Options

| Env | |
|---|---|
| `BULLPANE_SMOKE_PG_URL` | Postgres to use. Default `postgres://postgres:bullpane@127.0.0.1:5440/bullpane`; if nothing answers there, a throwaway `postgres:16-alpine` container is started and removed. |
| `SMOKE_SKIP` | Comma list of `interference`, `ui`, `free`, `environments`. |
| `SMOKE_PHASE_MS` | Length of each load phase (default 15 000). |
| `SMOKE_SCREENSHOTS` | Where the browser screenshots go (default: a temp dir, printed). |
| `SMOKE_NO_BUILD=1` | Do not rebuild `apps/web` first (it is rebuilt by default so the browser never tests a stale UI). |
| `SMOKE_CHROMIUM` | Path to a Chromium binary, instead of Playwright's. |
| `SMOKE_SERVER_LOG=1` | Print the server's log at the end. |

Every run works in its own schemas (`smoke_<random>`) and drops them.

## Reading the load numbers

The workers, the server and Postgres share one machine, so the stress phase
(~800 requests/s of heavy reads) measures CPU contention as much as anything:
it is held to a floor (40% of baseline), not to "no impact". The realistic
phase (10 tabs polling like the UI) must stay at ≥ 90%. The lock checks have no
tolerance: one violation fails the run.
