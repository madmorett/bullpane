-- Bullpane — initial schema. Applied by src/db/migrate.ts (statements split on ";\n").

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL DEFAULT 'viewer',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY sessions_user_id_idx (user_id),
  KEY sessions_expires_at_idx (expires_at),
  CONSTRAINT sessions_user_id_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connections (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  url TEXT NOT NULL,
  prefix VARCHAR(64) NOT NULL DEFAULT 'bull',
  cluster TINYINT(1) NOT NULL DEFAULT 0,
  queue_filter VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS folders (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  color VARCHAR(20) NULL,
  parent_id VARCHAR(36) NULL,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY folders_parent_id_idx (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS folder_queues (
  folder_id VARCHAR(36) NOT NULL,
  connection_id VARCHAR(36) NOT NULL,
  queue_name VARCHAR(255) NOT NULL,
  PRIMARY KEY (folder_id, connection_id, queue_name),
  CONSTRAINT folder_queues_folder_id_fk FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alerts (
  id VARCHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  connection_id VARCHAR(36) NOT NULL,
  queue_name VARCHAR(255) NULL,
  `condition` JSON NOT NULL,
  channels JSON NOT NULL,
  cooldown_minutes INT NOT NULL DEFAULT 30,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_fired_at DATETIME(3) NULL,
  firing TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY alerts_connection_id_idx (connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alert_events (
  id VARCHAR(36) NOT NULL,
  alert_id VARCHAR(36) NOT NULL,
  alert_name VARCHAR(120) NOT NULL,
  connection_id VARCHAR(36) NOT NULL,
  queue_name VARCHAR(255) NULL,
  kind VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  value DOUBLE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY alert_events_created_at_idx (created_at),
  KEY alert_events_alert_id_idx (alert_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_edges (
  id VARCHAR(36) NOT NULL,
  connection_id VARCHAR(36) NOT NULL,
  from_queue VARCHAR(255) NOT NULL,
  to_queue VARCHAR(255) NOT NULL,
  label VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY flow_edges_unique (connection_id, from_queue, to_queue)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(64) NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
