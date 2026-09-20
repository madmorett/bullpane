-- Alerts are scoped to a queue or a folder; connection-level alerts are gone.
ALTER TABLE alerts MODIFY connection_id VARCHAR(36) NULL;
ALTER TABLE alerts ADD COLUMN scope_type ENUM('queue','folder') NOT NULL DEFAULT 'queue' AFTER enabled;
ALTER TABLE alerts ADD COLUMN folder_id VARCHAR(36) NULL AFTER queue_name;
ALTER TABLE alerts ADD KEY alerts_folder_id_idx (folder_id);
ALTER TABLE alert_events MODIFY connection_id VARCHAR(36) NULL;
-- Rows that cannot be expressed in the new model (connection_down, "all queues of a connection").
DELETE FROM alerts WHERE JSON_UNQUOTE(JSON_EXTRACT(`condition`, '$.kind')) = 'connection_down';
DELETE FROM alerts WHERE scope_type = 'queue' AND queue_name IS NULL;
