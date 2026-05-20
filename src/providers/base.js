'use strict';

/**
 * BaseProvider — contract for all provider adapters.
 *
 * An adapter is responsible for:
 *   1. Listing models available upstream (optional override).
 *   2. Forwarding a chat.completions request in OpenAI format.
 *   3. Forwarding a responses request in OpenAI format when supported.
 *
 * The router handles:
 *   - authentication of the inbound request
 *   - model → provider lookup
 *   - logging & usage tracking
 *   - SSE streaming passthrough
 */

class BaseProvider {
  /**
   * @param {object} providerRow  DB row from `providers` table.
   */
  constructor(providerRow) {
    this.provider = providerRow;
  }

  /**
   * Return a readable name for logs.
   */
  get name() {
    return this.provider.name;
  }

  /**
   * Forward a chat.completions request. Must return:
   *   { status, headers, body, stream }
   * where `stream` is a Node Readable when streaming, else `body` is a JS object/string.
   *
   * @param {object} payload    OpenAI-format chat request body (upstream model already substituted).
   * @param {object} opts       { signal, stream: bool }
   * @returns {Promise<{status:number, headers:object, body?:any, stream?:ReadableStream}>}
   */
  async chatCompletions(_payload, _opts) {
    throw new Error('chatCompletions() not implemented');
  }

  /**
   * Forward a responses request. Must return:
   *   { status, headers, body, stream }
   * where `stream` is a web ReadableStream-like object when streaming, else
   * `body` is a JS object/string.
   *
   * @param {object} payload    OpenAI-format responses request body.
   * @param {object} opts       { signal, stream: bool }
   * @returns {Promise<{status:number, headers:object, body?:any, stream?:ReadableStream}>}
   */
  async responses(_payload, _opts) {
    throw new Error('responses() not implemented');
  }

  /**
   * Optional: list upstream models. Default returns empty.
   */
  async listModels() {
    return [];
  }
}

module.exports = BaseProvider;
