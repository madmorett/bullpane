-- Manual ordering for connections in the sidebar.
--
-- Deliberately NOT a per-user preference, and for the same reason as
-- `hidden_queues`: if a lead puts the production Redis at the top, it is at the
-- top for everyone. A sidebar whose order differs per person is a liability in
-- the middle of an incident, when one person is reading another's screen share.
--
-- `folders` already had `position` with these exact semantics; connections were
-- the odd one out, ordered by `created_at`, which meant the order was decided by
-- the accident of which Redis was added first and could never be changed.
--
-- Backfill: existing rows keep their current visible order. They were sorted by
-- `created_at`, so numbering them in that order makes this migration invisible.
--
-- WHY A SELF-JOIN AND NOT `SET @row := -1`: the migrator runs each statement
-- through `pool.query()`, and a pool hands out an arbitrary connection per call.
-- A user variable set in one statement would be NULL in the next one, silently
-- backfilling every row to 0. This counts predecessors per row instead, so it is
-- correct as a SINGLE statement regardless of which connection runs it.

ALTER TABLE connections ADD COLUMN position INT NOT NULL DEFAULT 0;

UPDATE connections AS c
SET position = (
  SELECT COUNT(*)
  FROM (SELECT id, created_at FROM connections) AS earlier
  WHERE earlier.created_at < c.created_at
     OR (earlier.created_at = c.created_at AND earlier.id < c.id)
);
