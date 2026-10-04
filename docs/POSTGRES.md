# BullMQ on Postgres

BullMQ 6 can keep its queues in PostgreSQL instead of Redis
(`createPostgresBackend`). Bullpane reads and operates those queues the same way
it does Redis ones: same pages, same actions, same alerts.

## Connecting

Add a connection, pick **Postgres (BullMQ 6)**, and give it:

| Field | What it is |
|---|---|
| URL | `postgres://user:password@host:5432/database`, the database your workers use. Paste it as your provider gives it; see TLS and poolers below. |
| Schema | The schema BullMQ created its tables in. BullMQ's default is `bullmq`. |
| Queue filter | Optional glob over queue names, as on Redis. |

Or seed it from the environment:

```bash
BULLPANE_CONNECTIONS='[{"name":"jobs","kind":"postgres","url":"postgres://app:pw@db:5432/app"}]'
```

Requirements:

- **BullMQ ≥ 6.0.3** wrote the schema (6.0.3 renamed schema objects; the schema
  is frozen for the rest of 6.x).
- **The schema must already exist.** Bullpane never runs BullMQ's migrations on
  your database. If it is missing, the connection says
  `postgres_schema_missing`: start one worker with `migrate: true`, or run
  `runMigrations()` once.
- **Role.** A read-only role is enough to browse everything, health card and
  connected workers included (tested with only `USAGE` on the schema and
  `SELECT` on its tables, workers running under another role):

  ```sql
  CREATE ROLE bullpane_ro LOGIN PASSWORD '…';
  GRANT USAGE ON SCHEMA bullmq TO bullpane_ro;
  GRANT SELECT ON ALL TABLES IN SCHEMA bullmq TO bullpane_ro;
  ```

  Actions (retry, remove, pause, clean, drain, add job) go through the official
  bullmq API and need the rights your workers have; with a read-only role they
  answer `403 database_permission_denied` and say so.

### TLS

`sslmode` means what it means in `psql`. A URL with `?sslmode=require`, as RDS,
Supabase or Neon hand it out, encrypts without verifying the certificate.
(node-postgres on its own treats `require` as `verify-full` and fails with
"unable to verify the first certificate" on any server whose CA Node does not
know; Bullpane gives `prefer`, `require` and `verify-ca` libpq semantics.)

| `sslmode` | Encrypted | Certificate checked |
|---|---|---|
| `require`, `prefer` | yes | no |
| `verify-ca&sslrootcert=/path/ca.pem` | yes | against that CA |
| `verify-full&sslrootcert=/path/ca.pem` | yes | against that CA, and the host name |
| `verify-full` | yes | against Node's public CAs; a private CA is refused |
| `no-verify` (node-postgres) | yes | no |

`sslrootcert` is a path on the machine running Bullpane (mount it into the
container).

### Poolers (PgBouncer, Supavisor, RDS Proxy)

Bullpane works behind a pooler in transaction mode. It first tries a session
setup (schema, statement timeout, no parallel query, sent as startup options)
and reads the settings back; a pooler refuses those options or drops them, and
then every read runs as its own `READ ONLY` transaction with `SET LOCAL`, so
nothing depends on which server connection the pooler hands out. Tested against
PgBouncer in transaction mode, with its defaults and with
`ignore_startup_parameters=options`: reads, search and actions, and concurrent
reads of two schemas that never cross.

Two things to know behind a pooler:
- each read costs three extra short round trips (BEGIN, SET LOCAL, COMMIT);
- **Workers connected** counts sessions named after the queue in
  `pg_stat_activity`. Workers that connect through the pooler appear under the
  pooler's own connections, so the count can read 0 while they work.

## What it costs your database

- **Reads** use a pool of at most 4 connections per Bullpane connection, named
  `bullpane-dashboard` in `pg_stat_activity`, with `statement_timeout = 10s` and
  **no parallel query** (`max_parallel_workers_per_gather = 0`): a count over a
  big state would otherwise take 3 cores at once from the workers. Every read is
  one SQL statement; queue lists read all queues of a connection in one statement.
- **Reads take no locks a worker could wait on.** Only `AccessShareLock` on the
  tables (what every `SELECT` takes; it conflicts with nothing BullMQ does) —
  no row locks, no open transactions. `pnpm smoke:postgres` checks this every
  25 ms under load.
- **Writes** open one bullmq `Queue` per queue touched, each with a pool of
  `max: 1` that closes when idle for 10 s.
- **Counts are real counts.** Postgres has no O(1) `LLEN`/`ZCARD`; each state is
  counted on its partial index, which is an index-only scan when autovacuum has
  kept the visibility map current. Counts are cached per queue for 2 s and
  shared by the overview, queue pages, job-list totals and the alerts engine, so
  ten open tabs cost what one does. Actions taken from Bullpane drop the cache.
- **Big states are recounted less often.** Under 100 000 jobs a count is fresh
  every 2 s. Above that it stays exact but is reused for longer, in proportion
  to its size: 20 s at 1M, 60 s from 3M up. Counting 10M completed jobs takes
  ~1.2 s of one core, so refreshing it every 2 s would keep a core of your
  database busy; once a minute is ~2%. Waiting and active counts stay fresh.

Measured on 1M jobs across 20 queues (Postgres 16, after autovacuum):

| Read | Time |
|---|---|
| Stats for all 20 queues | 60 ms |
| First page of a state | 3.4 ms |
| Page at offset 39 000 | 133 ms |
| Search (1 000 jobs scanned) | 9 ms |
| Discovery | < 1 ms |

Under a steady workload (20 workers, ~1 600 jobs/s, 320k jobs of history),
measured by `pnpm smoke:postgres`:

| Dashboard use | Worker throughput | Locks |
|---|---|---|
| 10 tabs polling like the UI | 98% of baseline (machine noise: 3%) | only AccessShareLock; no worker ever blocked |
| 20 clients, heavy reads, no pause (~800 req/s) | 54% (CPU shared on one 4-core box) | same |
| Retry 20k + clean 20k while workers run | 92% | workers blocked: 0 ms |

Right after a bulk load, before autovacuum runs, the same stats read took
3.3 s: the counts have to visit the heap. A queue table with heavy churn
benefits from a more aggressive `autovacuum_vacuum_scale_factor` on `job`.

## Differences from Redis

- **Paused** is a queue flag, not a place jobs move to. Jobs in a paused queue
  are shown as `waiting`, with the queue marked paused; the `paused` tab is
  always empty. This is BullMQ 6's own convention on Redis too.
- **Stalled** counts active jobs whose lock has expired.
- **BullMQ Pro groups** are not part of the open-source Postgres backend; the
  groups panel stays empty.
- **No `CLIENT LIST`.** Connected workers are read from `pg_stat_activity`:
  BullMQ names each worker's LISTEN connection after its queue.
- **The `event` table is never trimmed.** BullMQ 6's `trimEvents()` is not
  implemented on Postgres, so `event` grows forever. The health card shows its
  size and warns past 1 GiB. Delete old rows on a schedule, for example
  `DELETE FROM bullmq.event WHERE created_at_ms < (extract(epoch FROM now() - interval '7 days') * 1000)`.

## Developing

End to end (real server, real workers, real browser, load and lock checks):

```bash
pnpm smoke:postgres
```

See `apps/smoke/README.md`. Unit-level:

The pg-inspector integration suite runs against a real Postgres:

```bash
docker run -d --name bullpane-pg-dev --shm-size=512m \
  -e POSTGRES_PASSWORD=bullpane -e POSTGRES_DB=bullpane -p 5440:5432 postgres:16-alpine
pnpm --filter @bullpane/pg-inspector test
```

Each run creates and drops its own schema (`bp_test_<random>`). Point it
elsewhere with `BULLPANE_TEST_PG_URL`; when that variable is set (CI does) an
unreachable database fails the suite instead of skipping it.
