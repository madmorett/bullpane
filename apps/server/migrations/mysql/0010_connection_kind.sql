-- BullMQ 6 can keep its queues in PostgreSQL. A connection now says which
-- backend it points at; every existing row is a Redis connection. For a
-- Postgres connection, `prefix` holds the schema BullMQ created (default bullmq).
ALTER TABLE connections ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'redis' AFTER name;
