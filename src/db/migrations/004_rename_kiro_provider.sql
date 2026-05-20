-- 004_rename_kiro_provider.sql
-- Drop the historical "(Google Login)" suffix from any seeded Kiro provider
-- row so the dashboard shows a clean name + icon instead.

UPDATE providers
SET name = 'Kiro',
    updated_at = strftime('%s','now')
WHERE name = 'Kiro (Google Login)';
