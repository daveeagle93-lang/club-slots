-- The one shared settings row for first-run setup, recovery and the sign-in mode, on the site_settings pattern
-- (0009_site_settings.sql). Written by the first-run claim and /setup, by the recovery code flow, and by the Access
-- wizard; read to decide which sign-in provider is active and whether the claim window is open.
--
-- One row (id is always 1), seeded here. mode is 'password' until the Access wizard switches it to 'access', which the
-- last CHECK allows only with the team domain, aud and hostname all set. setup_opened_at is when this migration ran:
-- the claim window is computed from it on read, and a redeploy does not re-run the migration, so it does not reopen
-- the window. claim_token_hash is empty until the first-run claim sets it. recovery_hash is the same
-- `hmac-sha256$<salt>$<mac>` form as admin_credentials.secret_hash.
--
-- Deleting the admin_credentials row (docs/admin-auth.md) does not touch this row: the recovery code and the sign-in
-- mode must outlive the admin secret they recover.

CREATE TABLE auth_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  mode                TEXT NOT NULL DEFAULT 'password' CHECK (mode IN ('password', 'access')),
  access_team_domain  TEXT,
  access_aud          TEXT,
  access_hostname     TEXT,
  changed_at          TEXT,
  changed_by          TEXT CHECK (changed_by IS NULL OR changed_by IN ('wizard', 'recovery', 'import', 'owner')),
  setup_opened_at     TEXT NOT NULL,
  claim_token_hash    TEXT,
  recovery_hash       TEXT CHECK (recovery_hash IS NULL OR substr(recovery_hash, 1, 12) = 'hmac-sha256$'),
  recovery_created_at TEXT,
  CHECK (mode <> 'access' OR (access_team_domain IS NOT NULL AND access_aud IS NOT NULL AND access_hostname IS NOT NULL))
);

INSERT INTO auth_settings (id, setup_opened_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
