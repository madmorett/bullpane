-- Hidden queues: a queue the team no longer wants to SEE, per instance.
--
-- Deliberately NOT a per-user preference. If a lead hides a dead queue it is
-- dead for everyone; a dashboard that differs per person is a liability in the
-- middle of an incident. `hidden_by` records who did it so the choice can be
-- traced back, and the row is the whole state (present = hidden).
--
-- Nothing here touches Redis. The queue keeps running, keeps being measured by
-- alerts, and stays reachable by direct URL. This is the opposite of
-- `obliterate`, which deletes the queue and its jobs and cannot be undone.
--
-- No FK to `connections`: the queue name is a discovered string, not a row, and
-- ConnectionsService.remove() cleans these up alongside folder_queues.

CREATE TABLE IF NOT EXISTS hidden_queues (
  connection_id VARCHAR(36) NOT NULL,
  queue_name VARCHAR(255) NOT NULL,
  hidden_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  hidden_by VARCHAR(36) NULL,
  PRIMARY KEY (connection_id, queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
