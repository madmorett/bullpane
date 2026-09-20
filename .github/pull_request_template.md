<!--
Keep it short. The checklist below is the same ground rules as CONTRIBUTING.md —
tick what applies, delete what does not.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- The problem it solves. Skip if the title already says it. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] New Redis reads go through `packages/redis-inspector`, use no `KEYS` and no
      unbounded scan, and each call touches keys of a single queue (cluster safe)
- [ ] Writes go through the official `bullmq` API
- [ ] New or changed DTOs live in `packages/shared`
- [ ] Any new Pro feature is gated with `requireFeature()` on the server and
      `useEdition()` on the web — shown locked, never hidden
- [ ] No job payloads or Redis URLs are logged
- [ ] English only (docs, comments, test names, commit messages)

## Screenshots

<!-- For UI changes. Before/after if you are changing something that exists. -->
