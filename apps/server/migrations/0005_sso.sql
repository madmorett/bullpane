-- SSO (Pro): the customer's admin registers their own identity provider from
-- the Settings UI, so a self-hosted install can fix a bad issuer in the browser
-- instead of editing a compose file and redeploying.
--
-- WHY THE CONFIG IS A JSON COLUMN: the two protocols share almost no fields
-- (OIDC has issuer/client_id/scopes, SAML has entry_point/idp_cert), the shape
-- is validated by zod in @bullpane/shared before it ever reaches here, and no
-- query ever filters on a field inside it — providers are read whole, by id or
-- as a short list. Columns per protocol would mean half the table NULL and a
-- migration for every IdP quirk.
--
-- WHY THE SECRET IS ENCRYPTED AND NOT HASHED: we have to SEND the OIDC client
-- secret to the token endpoint, so it must be recoverable — unlike a password,
-- which only ever needs comparing. It is stored AES-256-GCM with a key derived
-- (HKDF) from SESSION_SECRET, in `secret_enc`, and is never returned by the API
-- (SsoProvider.hasSecret is the only thing the UI learns). Consequence the
-- operator must know: rotating SESSION_SECRET makes existing secrets
-- undecryptable and every provider has to have its secret re-entered.
-- SAML needs no secret: it verifies the IdP's signature with a public cert,
-- which lives in `config` in the clear on purpose.

CREATE TABLE IF NOT EXISTS sso_providers (
  id VARCHAR(36) NOT NULL,
  kind VARCHAR(10) NOT NULL,
  name VARCHAR(60) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  config JSON NOT NULL,
  -- AES-256-GCM ciphertext (iv.tag.data, base64url). NULL for SAML, and for an
  -- OIDC row whose secret has not been set yet.
  secret_enc TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The login page lists enabled providers on every render; keep it off a scan.
  KEY sso_providers_enabled_idx (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A user who only ever signs in through the IdP has no password, and inventing
-- one for them (a) is a credential nobody rotates and (b) is exactly the
-- friction SSO exists to remove. So the column becomes nullable; verifyPassword
-- refuses a NULL hash outright, which means such an account CANNOT fall back to
-- the password form even when the escape hatch is open.
ALTER TABLE users MODIFY password_hash VARCHAR(255) NULL;

-- How each live session was authenticated, so the audit log can say "signed in
-- with SSO" and a future forced-logout-on-SSO-change can target the right rows.
-- Existing sessions predate SSO, so 'password' is the correct backfill.
ALTER TABLE sessions ADD COLUMN auth_method VARCHAR(10) NOT NULL DEFAULT 'password';
