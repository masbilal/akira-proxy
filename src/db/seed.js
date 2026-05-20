'use strict';

/**
 * Seed default data: one example Kiro provider (disabled until user fills credentials).
 * Safe to run multiple times — uses INSERT OR IGNORE on unique slug.
 */

const db = require('./index');
const { run: migrate } = require('./migrate');

function seed() {
  migrate();

  const now = Math.floor(Date.now() / 1000);

  const upsertProvider = db.prepare(`
    INSERT OR IGNORE INTO providers
      (name, slug, type, base_url, auth_type, config_json, enabled, created_at, updated_at)
    VALUES (@name, @slug, @type, @base_url, @auth_type, @config_json, @enabled, @now, @now)
  `);

  upsertProvider.run({
    name: 'Kiro',
    slug: 'kiro',
    type: 'kiro',
    base_url: 'https://codewhisperer.us-east-1.amazonaws.com',
    auth_type: 'oauth',
    config_json: JSON.stringify({
      note: 'Requires OAuth token. Run `npm run login:kiro` to populate tokens (script WIP).',
    }),
    enabled: 0,
    now,
  });

  console.log('[seed] done');
}

if (require.main === module) {
  try {
    seed();
    process.exit(0);
  } catch (err) {
    console.error('[seed] failed:', err);
    process.exit(1);
  }
}

module.exports = { seed };
