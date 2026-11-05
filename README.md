# qrbeam

Send a large body of text from one screen to a phone using an **animated QR code**. No network or account is needed, and the text never leaves your devices.

**Live:** https://vishwas513.github.io/qrbeam/

- **Send:** paste text or open a `.txt` file. The page plays it as a looping animated QR code.
- **Receive:** open the page on your phone, point the camera at the animation and wait for the bar to fill. Then copy, share or save the text.

Both pages are plain static files. Once loaded (or added to the iPhone home screen), they work offline.

## How it works

1. **Compress.** The text is UTF-8 encoded and deflate-compressed with the browser's built-in `CompressionStream`. English prose shrinks 3–6×.
2. **Split.** The compressed bytes are cut into K equal chunks, one per QR frame (300–1,200 bytes depending on the density setting).
3. **Fountain-code.** Frames `0…K-1` carry the chunks in order. Every later frame carries the XOR of a pseudo-random half of the chunks (a *random linear fountain code*). The sender keeps producing new frames forever.
4. **Decode.** The receiver runs `jsQR` in a Web Worker and feeds each frame into an online Gaussian-elimination solver over GF(2). As soon as it holds K independent frames (in practice about K+2, whichever ones it caught), it rebuilds the chunks, checks a CRC-32, inflates the data and shows the text.

So a dropped or blurry frame doesn't mean waiting for that frame to come round again; any later frame is just as useful.

### Frame format

20-byte header (big-endian), then the chunk:

| bytes | field |
|---|---|
| 0 | magic `0xB7` |
| 1 | flags (bit 0 = deflate-compressed) |
| 2–5 | message id |
| 6–9 | payload length |
| 10–11 | K (number of chunks) |
| 12–15 | CRC-32 of the payload |
| 16–19 | frame sequence number |
| 20– | chunk data |

## Throughput

| density | bytes/frame | QR version | 50 KB of English text |
|---|---|---|---|
| Low | 300 | ~11 | 32 frames, ≈ 4.5 s at 8 fps |
| Medium (default) | 600 | ~17 | 16 frames, ≈ 2.5 s |
| High | 900 | ~21 | 11 frames, ≈ 1.5 s |
| Max | 1,200 | ~25 | 8 frames, ≈ 1.3 s (code must fill most of the camera view) |

These figures come from the browser test below (real `send.html` frames → fake 720p camera → real `receive.html`).

## Development

There's no build step. Serve the folder over HTTP (the camera needs HTTPS or `localhost`):

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

Tests (Node 18+):

```sh
node test/e2e.test.js        # codec: compression, fountain code under 0–90% frame loss, real QR render → jsQR
node test/browser.test.mjs   # full pages in headless Chrome with a fake webcam (needs Google Chrome)
```

`DENSITY=300|600|900|1200` and `TARGET=<px>` (QR size in the 720p fake camera image) tune the browser test.

## Third-party code

- [`vendor/jsQR.js`](https://github.com/cozmo/jsQR) 1.4.0, Apache-2.0. **Patched:** upstream's alignment-pattern table for QR version 23 has `74` where ISO/IEC 18004 specifies `78`, which made every version-23 code at error-correction level L unreadable. The one-line fix is marked `qrbeam patch` in the file.
- [`vendor/qrcode.js`](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (qrcode-generator), MIT.

## License

MIT. See [LICENSE](LICENSE).
