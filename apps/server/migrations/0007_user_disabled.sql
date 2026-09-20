-- Users are disabled, never deleted.
--
-- A deleted row takes the id with it, and the id is what everything else
-- remembers: audit rows name their actor by id, alert history and folder
-- ownership point at whoever created them, and an admin re-inviting the same
-- email got a NEW id that matched none of it. Disabling keeps the row, revokes
-- every session and refuses the next login (password or SSO), and can be undone.
--
-- Nullable timestamp rather than a boolean: "since when" is the first question
-- on the users page, and NULL stays the common case so no backfill is needed.

ALTER TABLE users ADD COLUMN disabled_at DATETIME(3) NULL;
