#!/usr/bin/env node
// Relay file hasil Hermes Agent → backend Umira AI.
//
// Jalankan DI SERVER HERMES bila Hermes tidak satu server dengan backend Umira AI.
// Hanya melayani file di dalam HERMES_OUTPUT_DIR, hanya untuk pemegang RELAY_KEY, hanya baca.
// Tanpa dependensi (Node 18+).
//
//   HERMES_OUTPUT_DIR=/root/.hermes/outputs RELAY_KEY=<rahasia-panjang> node hermes-file-relay.mjs
//   (opsional) RELAY_HOST=127.0.0.1 RELAY_PORT=8650 RELAY_MAX_MB=50
//
// Di backend Umira AI:
//   HERMES_OUTPUT_DIR=/root/.hermes/outputs
//   HERMES_FILES_RELAY_URL=http://<ip-server-hermes>:8650
//   HERMES_FILES_RELAY_KEY=<rahasia-panjang yang sama>
//
// GET /file?path=/root/.hermes/outputs/laporan.docx   (Authorization: Bearer <RELAY_KEY>)
// GET /health
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = (process.env.HERMES_OUTPUT_DIR ?? '').replace(/\/+$/, '');
const KEY = process.env.RELAY_KEY ?? '';
const HOST = process.env.RELAY_HOST ?? '127.0.0.1';
const PORT = Number(process.env.RELAY_PORT ?? 8650);
const MAX = Number(process.env.RELAY_MAX_MB ?? 50) * 1024 * 1024;

if (!ROOT || !path.isAbsolute(ROOT)) {
  console.error('HERMES_OUTPUT_DIR wajib diisi dengan path absolut.');
  process.exit(1);
}
if (KEY.length < 24) {
  console.error('RELAY_KEY wajib diisi (minimal 24 karakter), mis.: openssl rand -hex 32');
  process.exit(1);
}
fs.mkdirSync(ROOT, { recursive: true });
const ROOT_REAL = fs.realpathSync(ROOT);

const sameKey = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const send = (res, code, msg) => {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay');
    if (url.pathname === '/health') return send(res, 200, 'ok');
    if (req.method !== 'GET' || url.pathname !== '/file') return send(res, 404, 'not found');
    const auth = req.headers.authorization ?? '';
    if (!sameKey(auth.replace(/^Bearer\s+/i, ''), KEY)) return send(res, 401, 'unauthorized');

    const asked = url.searchParams.get('path') ?? '';
    if (!asked.startsWith(`${ROOT}/`)) return send(res, 403, 'di luar folder output');
    try {
      // realpath: tolak symlink yang mengarah ke luar folder output
      const real = await fsp.realpath(asked);
      if (!real.startsWith(ROOT_REAL + path.sep)) return send(res, 403, 'di luar folder output');
      const st = await fsp.stat(real);
      if (!st.isFile()) return send(res, 400, 'bukan file');
      if (st.size > MAX) return send(res, 413, `lebih dari ${MAX / 1048576} MB`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
      fs.createReadStream(real).pipe(res);
      console.log(`${new Date().toISOString()} kirim ${real} (${st.size} B)`);
    } catch (e) {
      send(res, e?.code === 'ENOENT' ? 404 : 500, e?.code === 'ENOENT' ? 'file tidak ditemukan' : 'gagal membaca file');
    }
  })
  .listen(PORT, HOST, () => console.log(`Hermes file relay → http://${HOST}:${PORT} · folder ${ROOT_REAL}`));
