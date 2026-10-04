# Contributing

Thanks for taking the time. Short version: small PRs, keep the performance
contract, do not break the demo.

## Setup

```sh
pnpm install
cp .env.example .env
pnpm dev                            # server :3000 + web (Vite) with proxy; SQLite, no database to start
pnpm dev:simulator                  # optional: fills your local Redis with traffic
```

`pnpm typecheck` and `pnpm test` must pass before you open a PR.

**Touching the schema?** It exists twice: `src/db/schema.mysql.ts` +
`migrations/mysql/` and `src/db/schema.sqlite.ts` + `migrations/sqlite/`. Change
both in the same PR (the typecheck fails if the row types drift), then run the
real-database suite against MySQL too:

```sh
docker run -d --rm --name bp-mysql -e MYSQL_ROOT_PASSWORD=root -p 33061:3306 mysql:8.4
BULLPANE_TEST_MYSQL_URL=mysql://root:root@127.0.0.1:33061 \
  pnpm --filter @bullpane/server exec vitest run src/__tests__/database.integration.test.ts
```

Without that variable the suite runs on SQLite only. To develop against MySQL:
`docker compose --profile mysql up -d mysql` and
`DATABASE_URL=mysql://bullpane:bullpane@localhost:3306/bullpane` in `.env`.

## Ground rules

1. **Every read of a customer's Redis goes through `packages/redis-inspector`,
   every read of a customer's Postgres through `packages/pg-inspector`.**
   No `KEYS`, one round trip per read (Lua / pipeline / one SQL statement),
   truncate on the server side, and on Postgres pin `state` in every job query.
   See "Performance contract" in `docs/ARCHITECTURE.md`. A PR that adds an
   O(queue size) command to a hot path will be asked to change.
2. **Writes use the official `bullmq` library.** Do not reimplement retry,
   promote, remove or clean.
3. **Types live in `packages/shared`.** If the server returns it or the UI
   sends it, the shape goes there first.
4. **Pro gating is one function** (`requireFeature` on the server,
   `useEdition` on the web). New Pro features are gated there, nowhere else.
5. **Key names are constants.** BullMQ keys in
   `packages/redis-inspector/src/keys.ts`; the simulator mirrors Pro group keys
   in `apps/simulator/src/lib/pro-groups.ts`. Change both together.

## Reporting bugs

Open an issue with: BullMQ version, Redis version (and cluster yes/no), the
queue's `meta` hash (`HGETALL bull:<queue>:meta`), and what the dashboard
showed vs. what you expected. Never paste job payloads with real customer
data.

## Commit messages

Imperative, present tense, under 72 chars. Reference the issue when there is one.

## License

Code outside an `ee/` directory is MIT, and by contributing to it you agree
your work is released under the MIT license in `LICENSE`.

Code inside `apps/server/src/ee/` and `apps/web/src/ee/` is the Pro edition,
under the Bullpane Commercial License. Contributions there are welcome; by
sending one you license it to the maintainer under the MIT license, so it can
ship as part of the Pro edition under the commercial license.
