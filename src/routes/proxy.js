'use strict';

const express = require('express');
const db = require('../db');
const { requireApiKey } = require('../middleware/auth');
const { proxyModelRequest } = require('../services/modelProxy');

const router = express.Router();

// All /v1/* routes require a valid API key.
router.use(requireApiKey);

/**
 * GET /v1/models
 * Returns only the models enabled in this router + mapped to an enabled provider.
 */
router.get('/models', (req, res) => {
  const rows = db.prepare(`
    SELECT m.name, m.display_name, p.name AS provider_name
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = 1 AND p.enabled = 1
      AND m.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY m.name ASC
  `).all();

  res.json({
    object: 'list',
    data: rows.map((r) => ({
      id: r.name,
      object: 'model',
      owned_by: r.provider_name,
    })),
  });
});

router.post('/responses', async (req, res) => {
  await proxyModelRequest({
    body: req.body || {},
    res,
    apiKeyId: req.apiKey.id,
    adapterMethod: 'responses',
    endpoint: '/v1/responses',
  });
});

/**
 * POST /v1/chat/completions
 * Resolves model -> provider, forwards request, streams if requested.
 */
router.post('/chat/completions', async (req, res) => {
  await proxyModelRequest({
    body: req.body || {},
    res,
    apiKeyId: req.apiKey.id,
    adapterMethod: 'chatCompletions',
    endpoint: '/v1/chat/completions',
  });
});

module.exports = router;
