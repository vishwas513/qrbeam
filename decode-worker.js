// Runs jsQR off the main thread so the camera preview stays smooth.
importScripts('vendor/jsQR.js');

self.onmessage = (e) => {
  const { buf, w, h } = e.data;
  let bytes = null;
  try {
    const r = jsQR(new Uint8ClampedArray(buf), w, h, { inversionAttempts: 'dontInvert' });
    if (r && r.binaryData && r.binaryData.length) bytes = Uint8Array.from(r.binaryData);
  } catch (_) { /* unreadable frame — ignore */ }
  self.postMessage({ bytes }, bytes ? [bytes.buffer] : []);
};
