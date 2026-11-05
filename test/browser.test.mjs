// Real-browser end-to-end test: send.html renders frames → recorded into a fake webcam video →
// receive.html scans it through getUserMedia + the worker → text must match exactly.
// Needs Google Chrome. Run: node test/browser.test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT = 8765, CDP_PORT = 9333;
const tmp = mkdtempSync(join(tmpdir(), 'qrbeam-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} rmSync(tmp, { recursive: true, force: true }); };

// ---- tiny CDP client -------------------------------------------------------------------
async function cdpTarget(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (res.ok) return res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map(), errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result?.result?.value;
  };
  const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(250); } return false; };
  return { ws, send, evaluate, waitFor, errors };
}
function launchChrome(extra) {
  const p = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(tmp, 'profile-' + procs.length)}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=900,1000', ...extra, 'about:blank'], { stdio: 'ignore' });
  procs.push(p); return p;
}

// ---- test text --------------------------------------------------------------------------
let seed = 3;
const words = 'beam light quiet résumé naïve 東京 🚀 river paper signal camera frame stream text over under across the a of'.split(' ');
const TEXT = Array.from({ length: 9000 }, () => words[(seed = (seed * 48271) % 2147483647) % words.length]).join(' ') + '\nEND ✓';

try {
  procs.push(spawn(process.env.PYTHON || '/usr/bin/python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' }));
  await sleep(800);

  // 1. Sender: render frames exactly as send.html does, and grab them as greyscale.
  let chrome = launchChrome([]);
  let page = await connect(await cdpTarget(`http://127.0.0.1:${HTTP_PORT}/send.html`));
  await page.waitFor(`typeof Fountain !== 'undefined' && document.readyState === 'complete'`, 10000);
  const K = await page.evaluate(`(async () => {
    const d = document.getElementById('density'); d.value = ${JSON.stringify(process.env.DENSITY || '600')};
    const t = document.getElementById('text'); t.value = ${JSON.stringify(TEXT)};
    t.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 600));
    return encoder.K;
  })()`);
  const N = K + 12;   // a few repair frames, as the loop would keep sending
  const shots = await page.evaluate(`(async () => {
    document.getElementById('start').click();
    await new Promise(r => setTimeout(r, 300));
    clearInterval(timer);
    const out = [], c = document.getElementById('qr');
    for (let i = 0; i < ${N}; i++) {
      draw(encoder.frame(i));
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let s = ''; for (let p = 0; p < d.length; p += 4) s += String.fromCharCode(d[p]);
      out.push({ w: c.width, b64: btoa(s) });
    }
    return out;
  })()`);
  const sendErrors = [...page.errors];
  page.ws.close(); chrome.kill('SIGKILL'); await sleep(500);
  console.log(`sender (density ${process.env.DENSITY || 600}): ${TEXT.length} chars → K=${K} frames, canvas ${shots[0].w}px`);

  // 2. Build a 30 fps fake-webcam Y4M: each QR shown for 4 camera frames (≈7.5 fps), with noise.
  const W = 1280, H = 720, HOLD = 4;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
  const parts = [header];
  let rnd = 1;
  const noise = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) >>> 24) % 25 - 12;
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  for (const shot of shots) {
    const src = Buffer.from(shot.b64, 'base64'), sw = shot.w;
    const target = Number(process.env.TARGET || 640);    // px the QR covers in the 720 px-high camera image
    for (let h = 0; h < HOLD; h++) {
      const Y = Buffer.alloc(W * H, 200);
      const ox = (W - target) >> 1, oy = (H - target) >> 1;
      for (let y = 0; y < target; y++) for (let x = 0; x < target; x++) {
        // Area-average a 3×3 grid of sample points, like a lens + sensor, instead of blocky nearest-neighbour.
        let acc = 0;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
          const v = src[Math.floor(((y + (sy + 0.5) / 3) * sw) / target) * sw + Math.floor(((x + (sx + 0.5) / 3) * sw) / target)];
          acc += v > 128 ? 225 : 30;
        }
        Y[(oy + y) * W + ox + x] = Math.max(0, Math.min(255, acc / 9 + noise()));
      }
      parts.push(Buffer.from('FRAME\n'), Y, chroma);
    }
  }
  const video = join(tmp, 'cam.y4m');
  writeFileSync(video, Buffer.concat(parts));

  // 3. Receiver: real page, fake camera, click Start, wait for the result.
  chrome = launchChrome(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`]);
  page = await connect(await cdpTarget(`http://127.0.0.1:${HTTP_PORT}/receive.html`));
  await page.waitFor(`document.readyState === 'complete'`, 10000);
  const t0 = Date.now();
  await page.evaluate(`document.getElementById('startBtn').click()`);
  const ok = await page.waitFor(`!document.getElementById('doneView').classList.contains('hidden')`, Number(process.env.TIMEOUT_MS || 60000));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await page.evaluate(`document.getElementById('doneInfo').textContent + ' | ' + document.getElementById('err').textContent + ' | progress ' + document.getElementById('sProgress').textContent`);
  const got = await page.evaluate(`document.getElementById('out').value`);
  const recvErrors = [...page.errors];

  if (sendErrors.length || recvErrors.length) console.log('console errors:', sendErrors, recvErrors);
  if (!ok) throw new Error(`receiver did not finish in time (${info})`);
  if (got !== TEXT) throw new Error(`text mismatch: got ${got.length} chars, expected ${TEXT.length}`);
  if (sendErrors.length || recvErrors.length) throw new Error('console errors');
  console.log(`receiver: done in ${secs} s — ${info}`);
  console.log('BROWSER TEST PASSED');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
