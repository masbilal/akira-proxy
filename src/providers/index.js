'use strict';

const OpenAIProvider = require('./openai');
const KiroProvider = require('./kiro');
const CodexProvider = require('./codex');

const REGISTRY = {
  openai: OpenAIProvider,
  kiro: KiroProvider,
  codex: CodexProvider,
};

function getAdapter(providerRow) {
  const Adapter = REGISTRY[providerRow.type];
  if (!Adapter) {
    throw new Error(`Unknown provider type: ${providerRow.type}`);
  }
  return new Adapter(providerRow);
}

function listTypes() {
  return Object.keys(REGISTRY);
}

module.exports = { getAdapter, listTypes };
