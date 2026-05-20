-- 005_codex_provider.sql
-- Seed the Codex provider (ChatGPT subscription login via OAuth PKCE) plus
-- the Codex model catalog. Tokens/accounts are populated later by
-- `npm run login:codex`.
--
-- base_url is informational only — the adapter hardcodes the ChatGPT backend
-- endpoints. auth_type='oauth' to match the Kiro pattern.

INSERT OR IGNORE INTO providers
  (name, slug, type, base_url, auth_type, config_json, enabled, created_at, updated_at)
VALUES (
  'Codex',
  'codex',
  'codex',
  'https://chatgpt.com/backend-api/codex',
  'oauth',
  '{"note":"Requires ChatGPT OAuth tokens. Run `npm run login:codex` to populate."}',
  0,
  strftime('%s','now'),
  strftime('%s','now')
);

-- Seed the Codex model catalog. Each model maps 1:1 to the Codex provider.
-- account_tier controls which subscription tiers are eligible to route here
-- (values align with Codex plan tiers: free/plus/pro/team/business/enterprise).
INSERT OR IGNORE INTO models
  (name, display_name, provider_id, upstream_model, enabled, account_tier, created_at, updated_at)
SELECT 'gpt-5.2-codex',        'GPT-5.2 Codex',        p.id, 'gpt-5.2-codex',        1, 'any', strftime('%s','now'), strftime('%s','now') FROM providers p WHERE p.slug = 'codex'
UNION ALL SELECT 'gpt-5.1-codex-max',    'GPT-5.1 Codex Max',    p.id, 'gpt-5.1-codex-max',    1, 'any', strftime('%s','now'), strftime('%s','now') FROM providers p WHERE p.slug = 'codex'
UNION ALL SELECT 'gpt-5.1-codex',        'GPT-5.1 Codex',        p.id, 'gpt-5.1-codex',        1, 'any', strftime('%s','now'), strftime('%s','now') FROM providers p WHERE p.slug = 'codex'
UNION ALL SELECT 'gpt-5.1-codex-mini',   'GPT-5.1 Codex Mini',   p.id, 'gpt-5.1-codex-mini',   1, 'any', strftime('%s','now'), strftime('%s','now') FROM providers p WHERE p.slug = 'codex'
UNION ALL SELECT 'gpt-5-codex',          'GPT-5 Codex',          p.id, 'gpt-5-codex',          1, 'any', strftime('%s','now'), strftime('%s','now') FROM providers p WHERE p.slug = 'codex'
UNION ALL SELECT 'gpt-5-codex-mini',     'GPT-5 Codex Mini',     p.id, 'gpt-5-codex-mini',     1, 'any', strftime('%s','now'), strftime('%s','now') FROM providers p WHERE p.slug = 'codex';
