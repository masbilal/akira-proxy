-- 010_proxy_features.sql
-- Granular proxy feature toggles.
--
-- Allows enabling/disabling proxy usage per feature (refresh_token,
-- token_import, api_request, warmup, etc.) and per provider.
--
-- Defaults:
--   - All features OFF unless explicitly enabled
--   - Settings stored in sync_config for global control
--   - Per-provider overrides stored in provider_proxy_features table

-- ========== 1. Global feature flags (in sync_config) ==========
INSERT OR IGNORE INTO sync_config (key, value, updated_at) VALUES
  ('proxy_feature_refresh_token', '0', strftime('%s','now')),
  ('proxy_feature_token_import', '0', strftime('%s','now')),
  ('proxy_feature_api_request', '0', strftime('%s','now')),
  ('proxy_feature_warmup', '0', strftime('%s','now')),
  ('proxy_feature_subscription_check', '0', strftime('%s','now')),
  ('proxy_feature_health_check', '1', strftime('%s','now'));

-- ========== 2. Per-provider feature overrides ==========
-- If a row exists here for a (provider_id, feature), it overrides the global flag.
-- value: '0' = forced off, '1' = forced on, NULL/missing = use global default
CREATE TABLE IF NOT EXISTS provider_proxy_features (
  provider_id   INTEGER NOT NULL,
  feature       TEXT NOT NULL,
  enabled       INTEGER NOT NULL,
  proxy_id      INTEGER,                    -- Optional: pin a specific proxy for this provider+feature
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (provider_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_provider_proxy_features_provider ON provider_proxy_features(provider_id);
