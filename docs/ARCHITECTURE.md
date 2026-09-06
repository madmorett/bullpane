# Architecture

BullMQ Visualizer is a self-hosted dashboard for BullMQ and BullMQ Pro. It follows the
Metabase model: a free edition that does everything the open-source dashboards do, and a
one-time paid Pro edition (USD 49) that unlocks team features.

```
bullmq-visualizer/
├── apps/
│   ├── server/          Fastify API + serves the built web UI. Owns MySQL, auth, alerts, licensing.
│   ├── web/             React + Vite dashboard.
│   └── simulator/       Generates realistic BullMQ (and fake Pro group) traffic for the live demo.
├── packages/
│   ├── shared/          Types + zod schemas shared by everything. THE contract.
│   └── redis-inspector/ ioredis + Lua scripts. All reads of a customer's Redis go through here.
├── scripts/gen-license.ts   Ed25519 keypair + license signing (vendor side).
├── Dockerfile               Multi-stage: build web + server, run one node process.
├── docker-compose.yml       app + mysql (bring your own Redis).
└── docker-compose.demo.yml  app + mysql + redis + simulator, DEMO_MODE=true.
```

## Data flow

```
Browser ──HTTP/JSON──> Fastify (apps/server)
                         │  auth (cookie session) · role check · pro-feature gate
                         ├──> MySQL (users, sessions, connections, folders, alerts, flow edges, settings)
                         └──> InspectorPool (packages/redis-inspector)
                                └──> ioredis per connection ──EVALSHA──> customer Redis
```

* The server never touches Redis directly. Everything goes through `Inspector`
  (`packages/redis-inspector/src/types.ts`).
* The inspector never touches MySQL. It is stateless apart from connection caches.
* The web UI only talks to `/api/*`. It polls; there is no websocket in v1
  (polling with a Lua-backed counts endpoint is one EVALSHA per queue, cheap enough).

## Performance contract (why the inspector exists)

Customers point this at production Redis. A dashboard that hurts the workload is worse than
no dashboard. Rules, enforced in `redis-inspector`:

1. **No `KEYS`, ever.** Discovery is `SCAN ... MATCH prefix:*:meta COUNT 500`, bounded by
   `maxScanIterations`, cached for `discoveryTtlMs` (30 s).
2. **One round trip per read.** Counts, pages and details are Lua scripts registered with
   `defineCommand` (EVALSHA). Multi-queue reads are a single pipeline.
3. **Truncate inside Redis.** List views return `string.sub(data, 1, previewBytes)`.
   A queue full of 500 KB payloads costs the same to render as a queue of tiny ones.
4. **Search is bounded and resumable.** Substring search runs in Lua over at most
   `maxScanPerCall` job hashes per call and hands back a cursor. The UI streams results in.
5. **Writes use the official bullmq library.** We do not reimplement retry/promote/remove;
   we inherit BullMQ's atomic scripts and stay correct across versions.
6. **Cluster safe.** Each script touches keys of exactly one queue (same hash tag).
7. **Connections fail fast.** `connectTimeout 5 s`, `maxRetriesPerRequest 1`,
   `enableOfflineQueue false`. A dead Redis produces a red badge, not a hung dashboard.

## Editions

| Capability | Free | Pro (USD 49, one-time) |
|---|---|---|
| Unlimited connections & queues | ✓ | ✓ |
| Job list / detail / search in data | ✓ | ✓ |
| Add · retry · promote · remove · clean · drain · pause | ✓ | ✓ |
| BullMQ Pro groups & batches view | ✓ | ✓ |
| Single admin login | ✓ | ✓ |
| Alerts per queue or per folder (waiting, failures, failure %) → Slack / webhook | – | ✓ |
| Users & roles (admin / operator / viewer) | – | ✓ |
| Folders to organise queues (default: one per connection) | – | ✓ |
| Flow graph (detected from BullMQ flows + manual edges) | – | ✓ |

Gating is one function on the server (`requireFeature(feature)`) returning HTTP 402
`{ error: "pro_required", feature }`, and one hook on the web (`useEdition()`), so the UI
shows the locked feature with a lock icon and an upsell instead of hiding it.

Licenses are Ed25519-signed offline tokens: `base64url(payload).base64url(signature)`.
No phone-home. The public key is compiled into the server; `scripts/gen-license.ts`
holds the vendor side. `DEMO_MODE=true` unlocks Pro with a "demo" badge and blocks
destructive settings changes so the public playground can't be broken.

## Roles

| Action | viewer | operator | admin |
|---|---|---|---|
| View queues, jobs, alerts, flows | ✓ | ✓ | ✓ |
| Add / retry / promote / remove jobs, pause / resume, clean, create alerts, manual flow edges, folders | – | ✓ | ✓ |
| Drain / obliterate queue, manage connections, users, license | – | – | ✓ |

In the free edition there is exactly one user (admin). Inviting more is a Pro feature.

## Flow detection

BullMQ flow children carry a `parent` field (`{ id, queueKey }`) in their job hash.
`sampleFlowEdges` reads the newest N jobs across states and aggregates `parent.queueKey`.
That yields `child → parent` edges with evidence counts at the cost of N `HMGET`s per queue
per refresh, bounded and cached. Plain "worker of A calls B.add()" cannot be observed from
Redis without instrumenting the producer, so those edges are drawn manually and stored in
MySQL. Both kinds render on the same graph, styled differently.

## BullMQ Pro

Pro queues share the standard key layout and add group keys under `${prefix}:${queue}:groups*`.
The inspector detects a Pro queue by `EXISTS groups` and reads groups read-only. Key names
are centralised in `packages/redis-inspector/src/keys.ts` so a layout change in Pro is a
one-file fix. The simulator writes the same layout so the demo shows groups without needing
a `@taskforcesh/bullmq-pro` token.
