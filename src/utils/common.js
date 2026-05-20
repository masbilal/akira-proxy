'use strict';

function now() {
  return Math.floor(Date.now() / 1000);
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function safeJsonParse(s, fallback = {}) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = { now, slugify, safeJsonParse, formatDate };
