/*
 * qrbeam fountain code — shared by the sender and the receiver.
 *
 * A message (compressed text) is split into K equal chunks. Frame `seq` carries
 * either one chunk (seq < K, "systematic" frames) or the XOR of a pseudo-random
 * half of the chunks (seq >= K, "repair" frames — a random linear fountain code).
 * The receiver solves the frames it has with Gaussian elimination over GF(2), so
 * ANY K linearly independent frames rebuild the message — in practice about K+2
 * frames, whichever ones it catches. A dropped or blurry frame never forces a wait
 * for that specific frame to come round again.
 *
 * Frame layout (big-endian), 20-byte header then chunk bytes:
 *   0      magic 0xB7
 *   1      flags  (bit0 = payload is deflate-raw compressed)
 *   2..5   message id
 *   6..9   payload length in bytes
 *   10..11 K (number of chunks)
 *   12..15 CRC-32 of the payload
 *   16..19 seq
 *   20..   chunk (all frames of a message have the same chunk size)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fountain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAGIC = 0xb7;
  const HEADER = 20;
  const FLAG_DEFLATE = 1;

  // ---- CRC-32 ---------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- deterministic PRNG (mulberry32) ----------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mix(a, b) {
    let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  /** Which chunk indices frame `seq` of message `id` combines. */
  function frameIndices(id, K, seq) {
    if (seq < K) return [seq];
    const rng = mulberry32(mix(id, seq));
    const out = [];
    for (let i = 0; i < K; i++) if (rng() < 0.5) out.push(i);
    if (out.length === 0) out.push(Math.floor(rng() * K));
    return out;
  }

  // ---- compression (CompressionStream: Safari 16.4+, Chrome 80+, Node 18+) ----
  const canCompress = typeof CompressionStream !== 'undefined';
  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
  const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'));

  // ---- encoder ---------------------------------------------------------------
  class Encoder {
    /** @param payload Uint8Array, @param chunkSize bytes of data per frame */
    constructor(payload, chunkSize, flags) {
      this.flags = flags | 0;
      this.length = payload.length;
      this.chunkSize = chunkSize;
      this.K = Math.max(1, Math.ceil(payload.length / chunkSize));
      if (this.K > 0xffff) throw new Error('Too much data for this frame size — increase density.');
      this.crc = crc32(payload);
      this.id = mix(this.crc, payload.length) || 1;
      this.chunks = [];
      for (let i = 0; i < this.K; i++) {
        const c = new Uint8Array(chunkSize);
        c.set(payload.subarray(i * chunkSize, (i + 1) * chunkSize));
        this.chunks.push(c);
      }
    }
    frame(seq) {
      const out = new Uint8Array(HEADER + this.chunkSize);
      const v = new DataView(out.buffer);
      out[0] = MAGIC;
      out[1] = this.flags;
      v.setUint32(2, this.id);
      v.setUint32(6, this.length);
      v.setUint16(10, this.K);
      v.setUint32(12, this.crc);
      v.setUint32(16, seq >>> 0);
      const body = out.subarray(HEADER);
      for (const i of frameIndices(this.id, this.K, seq)) {
        const c = this.chunks[i];
        for (let j = 0; j < c.length; j++) body[j] ^= c[j];
      }
      return out;
    }
  }

  /** Text → Encoder. Compresses when the browser supports it and it helps. */
  async function encodeText(text, chunkSize) {
    const raw = new TextEncoder().encode(text);
    let payload = raw, flags = 0;
    if (canCompress) {
      const z = await deflate(raw);
      if (z.length < raw.length) { payload = z; flags = FLAG_DEFLATE; }
    }
    const enc = new Encoder(payload, chunkSize, flags);
    enc.rawLength = raw.length;
    return enc;
  }

  // ---- decoder (peeling / belief propagation) ----------------------------------
  function parseFrame(bytes) {
    if (!bytes || bytes.length <= HEADER || bytes[0] !== MAGIC) return null;
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      flags: b[1],
      id: v.getUint32(2),
      length: v.getUint32(6),
      K: v.getUint16(10),
      crc: v.getUint32(12),
      seq: v.getUint32(16),
      data: b.slice(HEADER),
    };
  }

  /*
   * Online Gaussian elimination over GF(2). Each stored row is a coefficient
   * bit-vector over the K chunks plus the XOR of those chunks' bytes. Row r is
   * kept in pivotRows[p] where p is its lowest set bit, so reducing an incoming
   * frame only ever moves its lowest bit upward and terminates. Once all K
   * pivots exist the system is full rank; back-substitution yields the chunks.
   */
  class Decoder {
    constructor() { this.reset(); }
    reset() {
      this.id = null;
      this.K = 0;
      this.seen = new Set();
      this.rows = null;
      this.rank = 0;
      this.done = false;
    }
    /** Feed raw frame bytes. Returns 'new' | 'dup' | 'invalid' | 'switched' | 'useless'. */
    add(bytes) {
      const f = parseFrame(bytes);
      if (!f || f.K === 0) return 'invalid';
      let status = 'new';
      if (this.id !== f.id) {
        if (this.done) return 'dup';          // finished; ignore other streams
        const hadOther = this.id !== null;
        this.reset();
        Object.assign(this, { id: f.id, K: f.K, length: f.length, crc: f.crc,
                              flags: f.flags, chunkSize: f.data.length });
        this.words = (f.K + 31) >>> 5;
        this.rows = new Array(f.K).fill(null);
        if (hadOther) status = 'switched';
      }
      if (this.done || this.seen.has(f.seq)) return 'dup';
      if (f.data.length !== this.chunkSize) return 'invalid';
      this.seen.add(f.seq);
      const coef = new Uint32Array(this.words);
      for (const i of frameIndices(f.id, f.K, f.seq)) coef[i >>> 5] |= 1 << (i & 31);
      if (!this._insert(coef, f.data)) return 'useless';
      if (this.rank === this.K) { this._backSubstitute(); this.done = true; }
      return status;
    }
    _insert(coef, data) {
      for (;;) {
        const p = lowestBit(coef);
        if (p < 0) return false;              // linearly dependent on what we have
        const row = this.rows[p];
        if (!row) { this.rows[p] = { coef, data }; this.rank++; return true; }
        for (let w = p >>> 5; w < coef.length; w++) coef[w] ^= row.coef[w];
        xorInto(data, row.data);
      }
    }
    _backSubstitute() {
      for (let p = this.K - 1; p >= 0; p--) {
        const row = this.rows[p];
        for (let q = p + 1; q < this.K; q++) {
          if (row.coef[q >>> 5] & (1 << (q & 31))) xorInto(row.data, this.rows[q].data);
        }
      }
      this.chunks = this.rows.map((r) => r.data);
    }
    /** Fraction of the information received so far (rank / K). */
    get progress() { return this.K ? this.rank / this.K : 0; }
    get solved() { return this.rank; }
    /** Rebuild, verify CRC, decompress. Resolves to the text. */
    async text() {
      if (!this.done) throw new Error('Not complete');
      const payload = new Uint8Array(this.K * this.chunkSize);
      this.chunks.forEach((c, i) => payload.set(c, i * this.chunkSize));
      const body = payload.subarray(0, this.length);
      if (crc32(body) !== this.crc) throw new Error('Checksum mismatch — please rescan.');
      const raw = this.flags & FLAG_DEFLATE ? await inflate(body) : body;
      return new TextDecoder().decode(raw);
    }
  }
  function lowestBit(v) {
    for (let w = 0; w < v.length; w++) {
      const x = v[w];
      if (x) return (w << 5) + (31 - Math.clz32(x & -x));
    }
    return -1;
  }
  function xorInto(dst, src) {
    for (let j = 0; j < dst.length; j++) dst[j] ^= src[j];
  }

  return { Encoder, Decoder, encodeText, parseFrame, frameIndices, crc32, HEADER, canCompress };
});
