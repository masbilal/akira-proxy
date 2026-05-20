'use strict';

const crypto = require('crypto');

/**
 * API key format: `akr-<26-char-id>` (Akira Proxy).
 * We store sha256(fullKey) as key_hash. The full key is only shown once on create.
 */
const PREFIX = 'akr-';

function generateApiKey() {
  const rand = crypto.randomBytes(20).toString('base64url'); // ~26 chars
  return PREFIX + rand;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function shortPrefix(key) {
  return key.slice(0, 12); // e.g. "akr-abcDefG"
}

module.exports = { generateApiKey, hashApiKey, shortPrefix, PREFIX };
