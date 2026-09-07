-- Audit log: the durable answer to "who did this to my production queue?".
--
-- The trail already existed as pino lines ({ queue, jobId, by }) in every
-- mutating handler. A log file that dies with the container and that nobody can
-- query is not an audit trail, it is a debugging aid. This table is the same
-- information, persisted, filterable and exportable.
--
-- WHY THE ACTOR IS DENORMALISED (actor_email / actor_name / actor_role):
-- an audit row whose only pointer to the person is a foreign key stops meaning
-- anything the moment that user is deleted — and "the person who did it left the
-- company" is precisely the case an auditor cares about. So there is deliberately
-- NO FK to `users`, and no FK to `connections` either: the connection name is
-- copied in, because a deleted connection must not erase what was done to it.
-- Rows are append-only by design; no route updates or deletes them (retention
-- pruning by age is the single exception).
--
-- WHAT IS NOT HERE: the job's `data`. `detail` carries the PARAMETERS of the
-- action (clean state/grace/limit, how many jobs were removed, the job name,
-- payload size in bytes) and never the payload itself, which routinely holds
-- customer PII. That rule is in CLAUDE.md ("never log job data") and is covered
-- by a test.
--
-- SIZE: a typical row is ~350-600 bytes on disk including the two indexes
-- (fixed columns ~120 B, user agent ~120 B, detail JSON usually < 200 B). At
-- 10k mutating actions/day that is ~2 GB/year; a dashboard where humans click
-- buttons is more like 200/day, i.e. ~40 MB/year. Retention is
-- BULLPANE_AUDIT_RETENTION_DAYS (default 365) and the prune runs with the alerts
-- engine tick.

CREATE TABLE IF NOT EXISTS audit_log (
  id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Denormalised actor. NULL actor_id = anonymous call (failed login on an
  -- unknown email). The other three survive the user row being deleted.
  actor_id VARCHAR(36) NULL,
  actor_email VARCHAR(255) NULL,
  actor_name VARCHAR(80) NULL,
  actor_role VARCHAR(20) NULL,
  action VARCHAR(40) NOT NULL,
  -- Denormalised target. Queues are discovered strings, not rows, so there is
  -- nothing to reference even in principle.
  connection_id VARCHAR(36) NULL,
  connection_name VARCHAR(80) NULL,
  queue_name VARCHAR(255) NULL,
  job_id VARCHAR(255) NULL,
  result VARCHAR(10) NOT NULL DEFAULT 'ok',
  error_message VARCHAR(500) NULL,
  detail JSON NULL,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  PRIMARY KEY (id),
  -- The main query is "newest first, optionally filtered". Paging is keyset on
  -- (created_at, id), so this index serves both the ordering and the cursor.
  KEY audit_log_created_at_idx (created_at, id),
  KEY audit_log_actor_id_idx (actor_id),
  KEY audit_log_queue_idx (connection_id, queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
