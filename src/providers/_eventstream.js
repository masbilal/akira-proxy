'use strict';

/**
 * Minimal AWS Event Stream (vnd.amazon.eventstream) frame parser.
 *
 * Each frame:
 *   bytes 0..3   total length (big-endian uint32)
 *   bytes 4..7   headers length (big-endian uint32)
 *   bytes 8..11  prelude crc (big-endian uint32)    [we ignore]
 *   bytes 12..12+headersLen-1    headers
 *   bytes ...                    payload (JSON bytes in Kiro's case)
 *   last 4 bytes message crc                        [we ignore]
 *
 * Headers format (repeated until headersLen consumed):
 *   1 byte   name length N
 *   N bytes  name
 *   1 byte   header value type (7 = UTF-8 string)
 *   2 bytes  value length V (if type = 7)
 *   V bytes  value
 *
 * We only care about:
 *   :message-type  -> "event" | "exception" | "error"
 *   :event-type    -> e.g. "assistantResponseEvent"
 *   :content-type  -> e.g. "application/json"
 *
 * Returns an async generator over { headers, payload, payloadBuffer }.
 */

function parseHeaders(buf) {
  const out = {};
  let off = 0;
  while (off < buf.length) {
    const nameLen = buf.readUInt8(off);
    off += 1;
    const name = buf.slice(off, off + nameLen).toString('utf8');
    off += nameLen;
    const type = buf.readUInt8(off);
    off += 1;
    if (type === 7) {
      const vlen = buf.readUInt16BE(off);
      off += 2;
      const val = buf.slice(off, off + vlen).toString('utf8');
      off += vlen;
      out[name] = val;
    } else {
      // Unsupported header type; skip rest to be safe
      return out;
    }
  }
  return out;
}

/**
 * Parse a Node.js Readable stream of AWS event-stream frames.
 * Yields decoded events.
 */
async function* parseEventStream(readable) {
  let buffer = Buffer.alloc(0);
  const reader = readable.getReader ? readable.getReader() : null;

  async function nextChunk() {
    if (reader) {
      const { value, done } = await reader.read();
      if (done) return null;
      return Buffer.from(value);
    }
    return new Promise((resolve) => {
      readable.once('data', (c) => resolve(Buffer.from(c)));
      readable.once('end', () => resolve(null));
      readable.once('error', () => resolve(null));
    });
  }

  while (true) {
    // Need at least prelude
    while (buffer.length < 12) {
      const chunk = await nextChunk();
      if (!chunk) return;
      buffer = Buffer.concat([buffer, chunk]);
    }
    const totalLen = buffer.readUInt32BE(0);
    const headersLen = buffer.readUInt32BE(4);
    if (totalLen < 16 || totalLen > 10 * 1024 * 1024) {
      // Corrupt; drop rest
      return;
    }
    // Need full frame
    while (buffer.length < totalLen) {
      const chunk = await nextChunk();
      if (!chunk) return;
      buffer = Buffer.concat([buffer, chunk]);
    }
    const frame = buffer.slice(0, totalLen);
    buffer = buffer.slice(totalLen);

    const headersBuf = frame.slice(12, 12 + headersLen);
    const payloadBuf = frame.slice(12 + headersLen, frame.length - 4);
    const headers = parseHeaders(headersBuf);

    let payload = null;
    const ct = headers[':content-type'] || '';
    if (/json/i.test(ct)) {
      try {
        payload = JSON.parse(payloadBuf.toString('utf8'));
      } catch {
        /* fall through */
      }
    }

    yield { headers, payload, payloadBuffer: payloadBuf };
  }
}

module.exports = { parseEventStream, parseHeaders };