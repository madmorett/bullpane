-- MCP (Pro): Claude and other MCP clients connect to /mcp with OAuth 2.1. The
-- user signs in to Bullpane the way they always do (password or SSO), approves
-- the client on a consent screen, and the client gets tokens tied to that user.
--
-- THREE TABLES, AND WHY NOT AN ACCESS-TOKEN TABLE. Access tokens are short-lived
-- (1 h) and signed (HMAC, key derived from SESSION_SECRET) with the grant id
-- inside, so a call needs no lookup of the token itself. It still loads the grant
-- and its user on every call — that is what makes revoking a client, disabling a
-- user or lowering the admin's ceiling take effect at once instead of at expiry.
--
--  * mcp_clients     : dynamically registered clients (RFC 7591). Public clients,
--                      no secret: PKCE is what binds the code to the client.
--  * mcp_auth_codes  : single-use authorization codes, 60 s. In MySQL rather than
--                      in memory so two replicas behind a load balancer work.
--  * mcp_grants      : one row per approved consent = one refresh-token family.
--                      Refresh tokens rotate on use; presenting the previous one
--                      again means it leaked, and the whole grant is deleted.
--
-- Codes and refresh tokens are stored as SHA-256 hashes: a database dump does
-- not yield a usable token.

CREATE TABLE IF NOT EXISTS mcp_clients (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  redirect_uris JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY mcp_clients_created_at_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcp_auth_codes (
  code_hash VARCHAR(64) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  access VARCHAR(10) NOT NULL,
  redirect_uri VARCHAR(2048) NOT NULL,
  code_challenge VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (code_hash),
  KEY mcp_auth_codes_expires_at_idx (expires_at),
  CONSTRAINT mcp_auth_codes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT mcp_auth_codes_client_fk FOREIGN KEY (client_id) REFERENCES mcp_clients (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcp_grants (
  id VARCHAR(36) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  access VARCHAR(10) NOT NULL,
  refresh_hash VARCHAR(64) NOT NULL,
  -- the refresh token this one replaced; seeing it again = reuse = revoke
  prev_refresh_hash VARCHAR(64) NULL,
  refresh_expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY mcp_grants_refresh_hash_unique (refresh_hash),
  KEY mcp_grants_prev_refresh_hash_idx (prev_refresh_hash),
  KEY mcp_grants_user_id_idx (user_id),
  CONSTRAINT mcp_grants_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT mcp_grants_client_fk FOREIGN KEY (client_id) REFERENCES mcp_clients (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
