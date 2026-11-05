// End-to-end test: text → compress → fountain frames → QR images → jsQR → fountain decode → text.
// Run: node test/e2e.test.js
const assert = require('assert');
const crypto = require('crypto');
const F = require('../fountain.js');
const qrcode = require('../vendor/qrcode.js');
const jsQR = require('../vendor/jsQR.js');

// Render bytes to a QR image (RGBA, 3 px/module, 4-module quiet zone), exactly as the sender page does.
function render(bytes, ecc) {
  const qr = qrcode(0, ecc);
  qr.addData(String.fromCharCode.apply(null, bytes), 'Byte');
  qr.make();
  const n = qr.getModuleCount(), scale = 3, quiet = 4, size = (n + quiet * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const o = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return { px, size, version: (n - 17) / 4 };
}

async function roundTrip(text, chunk, { loss = 0, viaQR = false, ecc = 'L', seed = 1 } = {}) {
  const enc = await F.encodeText(text, chunk);
  const dec = new F.Decoder();
  let rnd = seed, frames = 0, version = 0;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let seq = 0; !dec.done; seq++) {
    if (seq > enc.K * 20 + 200) throw new Error(`did not converge (K=${enc.K})`);
    if (rand() < loss) continue;
    let bytes = enc.frame(seq);
    if (viaQR) {
      const img = render(bytes, ecc);
      version = img.version;
      const res = jsQR(img.px, img.size, img.size, { inversionAttempts: 'dontInvert' });
      assert(res, `jsQR failed to read frame ${seq} (QR v${img.version})`);
      bytes = Uint8Array.from(res.binaryData);
    }
    frames++;
    dec.add(bytes);
  }
  const out = await dec.text();
  assert.strictEqual(out, text);
  return { K: enc.K, frames, overhead: frames / enc.K, raw: enc.rawLength, payload: enc.length, version };
}

(async () => {
  const words = 'the quick brown fox jumps over lazy dog résumé naïve 日本語 emoji 🚀 lorem ipsum dolor sit amet'.split(' ');
  let r = 7;
  const prose = (n) => Array.from({ length: n }, () => words[(r = (r * 48271) % 2147483647) % words.length]).join(' ');

  // 1. Tiny, empty-ish and unicode inputs.
  for (const t of ['a', 'Hello, world!', '🚀'.repeat(50), prose(10)]) await roundTrip(t, 100);

  // 2. Incompressible random data still works (sent uncompressed).
  const rand = crypto.randomBytes(5000).toString('base64');
  await roundTrip(rand, 400, { loss: 0.3 });

  // 3. Loss sweep on a long text — measure fountain overhead.
  const big = prose(30000); // ~200 KB
  for (const loss of [0, 0.3, 0.6, 0.9]) {
    const s = await roundTrip(big, 700, { loss, seed: 42 + loss * 10 });
    console.log(`loss ${loss * 100}%: raw ${s.raw} B → payload ${s.payload} B, K=${s.K}, frames needed ${s.frames} (K+${s.frames - s.K})`);
    assert(s.frames <= s.K + 10, `too many frames needed: ${s.frames} for K=${s.K}`);
  }

  // 3b. A large message (~1 MB text, K≈400): time to encode + decode every frame.
  const huge = prose(150000);
  const t0 = Date.now();
  const hs = await roundTrip(huge, 700, { loss: 0.5, seed: 9 });
  console.log(`large: raw ${hs.raw} B → ${hs.payload} B, K=${hs.K}, frames K+${hs.frames - hs.K}, ${Date.now() - t0} ms total`);

  // 4. Full pipeline through real QR images and jsQR, with 30% frame loss.
  for (const [chunk, ecc] of [[300, 'L'], [700, 'L'], [1000, 'L'], [700, 'M']]) {
    const s = await roundTrip(prose(3000), chunk, { loss: 0.3, viaQR: true, ecc, seed: chunk });
    console.log(`QR chunk ${chunk} ecc ${ecc}: v${s.version}, K=${s.K}, frames ${s.frames} — OK`);
  }

  // 5. Decoder ignores garbage and switches cleanly to a new stream.
  const dec = new F.Decoder();
  assert.strictEqual(dec.add(new Uint8Array([1, 2, 3])), 'invalid');
  const a = await F.encodeText(prose(500), 200), b = await F.encodeText(prose(400), 200);
  dec.add(a.frame(0));
  assert.strictEqual(dec.add(b.frame(0)), 'switched');
  for (let s = 1; !dec.done; s++) dec.add(b.frame(s));
  assert.strictEqual(await dec.text(), new TextDecoder().decode(new TextEncoder().encode(await (async () => {
    const d = new F.Decoder(); for (let s = 0; !d.done; s++) d.add(b.frame(s)); return d.text(); })())));

  console.log('ALL TESTS PASSED');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
