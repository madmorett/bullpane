# BullMQ on Postgres

BullMQ 6 can keep its queues in PostgreSQL instead of Redis
(`createPostgresBackend`). Bullpane reads and operates those queues the same way
it does Redis ones: same pages, same actions, same alerts.

## Connecting

Add a connection, pick **Postgres (BullMQ 6)**, and give it:

| Field | What it is |
|---|---|
| URL | `postgres://user:password@host:5432/database`, the database your workers use. Add `?sslmode=require` for TLS. |
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
- **Role.** `SELECT` on the schema is enough to browse. Actions (retry, remove,
  pause, clean, drain, add job) go through the official bullmq API and need the
  same rights your workers have. The health card reads `pg_stat_database`,
  readable by any role. Connected workers come from `pg_stat_activity`; Postgres
  hides some columns of other roles' sessions, so if the dashboard uses a
  different role than the workers and shows 0 workers, grant it
  `pg_read_all_stats`.

## What it costs your database

- **Reads** use a pool of at most 4 connections per Bullpane connection, named
  `bullpane-dashboard` in `pg_stat_activity`, with `statement_timeout = 10s`.
  Every read is one SQL statement; queue lists read all queues of a connection
  in one statement.
- **Writes** open one bullmq `Queue` per queue touched, each with a pool of
  `max: 1` that closes when idle for 10 s.
- **Counts are real counts.** Postgres has no O(1) `LLEN`/`ZCARD`; each state is
  counted on its partial index, which is an index-only scan when autovacuum has
  kept the visibility map current. Identical stats reads within 2 s share one
  statement (open tabs and the alerts engine do not multiply the load).

Measured on 1M jobs across 20 queues (Postgres 16, after autovacuum):

| Read | Time |
|---|---|
| Stats for all 20 queues | 60 ms |
| First page of a state | 3.4 ms |
| Page at offset 39 000 | 133 ms |
| Search (1 000 jobs scanned) | 9 ms |
| Discovery | < 1 ms |

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

The pg-inspector integration suite runs against a real Postgres:

```bash
docker run -d --name bullpane-pg-dev --shm-size=512m \
  -e POSTGRES_PASSWORD=bullpane -e POSTGRES_DB=bullpane -p 5440:5432 postgres:16-alpine
pnpm --filter @bullpane/pg-inspector test
```

Each run creates and drops its own schema (`bp_test_<random>`). Point it
elsewhere with `BULLPANE_TEST_PG_URL`; when that variable is set (CI does) an
unreachable database fails the suite instead of skipping it.
