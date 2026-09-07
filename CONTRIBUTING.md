# Contributing

Thanks for taking the time. Short version: small PRs, keep the performance
contract, do not break the demo.

## Setup

```sh
pnpm install
docker compose up mysql -d          # local MySQL on 3306 (bullpane/bullpane)
cp .env.example .env
pnpm dev                            # server :3000 + web (Vite) with proxy
pnpm dev:simulator                  # optional: fills your local Redis with traffic
```

`pnpm typecheck` and `pnpm test` must pass before you open a PR.

## Ground rules

1. **Every read of a customer's Redis goes through `packages/redis-inspector`.**
   No `KEYS`, one round trip per read (Lua / pipeline), truncate inside Redis.
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

By contributing you agree your work is released under the MIT license in
`LICENSE`. The Pro edition is the same code with a license key; contributions
to Pro-gated features are welcome and stay MIT.
