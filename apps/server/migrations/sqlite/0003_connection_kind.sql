-- Same change as migrations/mysql/0010_connection_kind.sql: which backend a
-- connection points at. Existing rows are Redis.
ALTER TABLE connections ADD COLUMN kind TEXT NOT NULL DEFAULT 'redis';
