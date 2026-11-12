// Mock Synology DSM Web API untuk development/testing tanpa NAS asli.
// Meniru: SYNO.API.Info, SYNO.API.Auth (login/logout, 2FA + device token),
//         SYNO.FileStation.List (list_share, list), Search (start/list/stop/clean), Download, Upload.
//
// Jalankan: node tools/mock-synology.mjs
//   PORT=5001 DATA_DIR=./tools/mock-synology-data SID_TTL_SEC=604800
// Akun: rina / rina123 (akses share "proyek" & "home"),  budi / budi123 + OTP 123456 (2FA, hanya "home")
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 5001);
const ROOT = path.resolve(process.env.DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-synology-data'));
const SID_TTL = Number(process.env.SID_TTL_SEC ?? 7 * 86400) * 1000;

const USERS = {
  rina: { password: 'rina123', shares: ['proyek', 'home'] },
  budi: { password: 'budi123', otp: '123456', shares: ['home'] },
};
const sessions = new Map(); // sid -> { user, exp }
const devices = new Map(); // did -> user
const searches = new Map(); // taskid -> { files, polls }

fs.mkdirSync(ROOT, { recursive: true });
for (const s of ['proyek', 'home']) fs.mkdirSync(path.join(ROOT, s), { recursive: true });

const ok = (res, data = {}) => json(res, { success: true, data });
const err = (res, code) => json(res, { success: false, error: { code } });
function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset="UTF-8"' });
  res.end(JSON.stringify(body));
}
const API_INFO = {
  'SYNO.API.Auth': { path: 'entry.cgi', minVersion: 1, maxVersion: 7 },
  'SYNO.FileStation.List': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
  'SYNO.FileStation.Search': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
  'SYNO.FileStation.Download': { path: 'entry.cgi', minVersion: 1, maxVersion: 2 },
  'SYNO.FileStation.Upload': { path: 'entry.cgi', minVersion: 1, maxVersion: 3 },
};

/** Ubah parameter path DSM (string ber-quote JSON atau polos) menjadi path asli. */
function parsePathParam(v) {
  if (v == null) return null;
  try {
    const p = JSON.parse(v);
    return p;
  } catch {
    return v;
  }
}
function realPath(user, p) {
  const share = p.split('/')[1];
  if (!share || !USERS[user].shares.includes(share)) return { error: 105 };
  const full = path.resolve(ROOT, '.' + p);
  if (!full.startsWith(ROOT)) return { error: 400 };
  return { full };
}
function fileEntry(p, full) {
  const st = fs.statSync(full);
  return { path: p, name: path.basename(p), isdir: st.isDirectory(), additional: { size: st.size, time: { mtime: Math.floor(st.mtimeMs / 1000) } } };
}
function walk(user, dir, pattern, out) {
  const { full } = realPath(user, dir);
  for (const name of fs.readdirSync(full)) {
    const p = `${dir}/${name}`;
    const f = path.join(full, name);
    if (pattern.test(name)) out.push(fileEntry(p, f));
    if (fs.statSync(f).isDirectory()) walk(user, p, pattern, out);
  }
}
function globToRe(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let q = Object.fromEntries(url.searchParams);
    if (url.pathname === '/webapi/query.cgi' && q.api === 'SYNO.API.Info') return ok(res, API_INFO);
    // khusus testing: paksa semua sesi kedaluwarsa (meniru batas 7 hari DSM)
    if (url.pathname === '/__expire_sessions') {
      for (const v of sessions.values()) v.exp = 0;
      return ok(res, { expired: sessions.size });
    }
    if (url.pathname !== '/webapi/entry.cgi') return err(res, 102);

    let bodyBuf = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      bodyBuf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] ?? '';
      if (ct.startsWith('application/x-www-form-urlencoded')) q = { ...q, ...Object.fromEntries(new URLSearchParams(bodyBuf.toString())) };
    }

    // ---------- Auth
    if (q.api === 'SYNO.API.Auth') {
      if (q.method === 'login') {
        const u = USERS[q.account];
        if (!u || u.password !== q.passwd) return err(res, 400);
        if (u.otp) {
          const trusted = q.device_id && devices.get(q.device_id) === q.account;
          if (!trusted) {
            if (!q.otp_code) return err(res, 403);
            if (q.otp_code !== u.otp) return err(res, 404);
          }
        }
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.set(sid, { user: q.account, exp: Date.now() + SID_TTL });
        const data = { sid, is_portal_port: false };
        if (q.enable_device_token === 'yes' && q.otp_code) {
          const did = crypto.randomBytes(16).toString('hex');
          devices.set(did, q.account);
          data.did = did;
        }
        return ok(res, data);
      }
      if (q.method === 'logout') {
        sessions.delete(q._sid);
        return ok(res);
      }
      return err(res, 103);
    }

    // ---------- Session
    const s = sessions.get(q._sid);
    if (!s) return err(res, 119);
    if (s.exp < Date.now()) {
      sessions.delete(q._sid);
      return err(res, 106);
    }
    const user = s.user;

    // ---------- List
    if (q.api === 'SYNO.FileStation.List') {
      if (q.method === 'list_share') {
        const shares = USERS[user].shares.map((n) => ({ path: `/${n}`, name: n, isdir: true, additional: { time: { mtime: 0 } } }));
        return ok(res, { total: shares.length, offset: 0, shares });
      }
      if (q.method === 'list') {
        const p = parsePathParam(q.folder_path);
        const r = realPath(user, p);
        if (r.error) return err(res, r.error);
        if (!fs.existsSync(r.full)) return err(res, 408);
        const files = fs.readdirSync(r.full).map((n) => fileEntry(`${p}/${n}`, path.join(r.full, n)));
        const off = Number(q.offset ?? 0);
        const lim = Number(q.limit ?? 0) || files.length;
        return ok(res, { total: files.length, offset: off, files: files.slice(off, off + lim) });
      }
    }

    // ---------- Search
    if (q.api === 'SYNO.FileStation.Search') {
      if (q.method === 'start') {
        const folders = parsePathParam(q.folder_path);
        const out = [];
        for (const f of [].concat(folders)) {
          const r = realPath(user, f);
          if (r.error) return err(res, r.error);
          walk(user, f, globToRe(q.pattern || '*'), out);
        }
        const taskid = `FileStation_${crypto.randomBytes(6).toString('hex')}`;
        searches.set(taskid, { files: out, polls: 0 });
        return ok(res, { taskid });
      }
      if (q.method === 'list') {
        const t = searches.get(parsePathParam(q.taskid));
        if (!t) return err(res, 401);
        t.polls++;
        const finished = t.polls >= 2; // meniru pencarian bertahap
        const files = finished ? t.files : t.files.slice(0, Math.ceil(t.files.length / 2));
        return ok(res, { total: files.length, offset: 0, finished, files: files.slice(0, Number(q.limit) || undefined) });
      }
      if (q.method === 'stop') return ok(res);
      if (q.method === 'clean') {
        searches.delete(parsePathParam(q.taskid));
        return ok(res);
      }
    }

    // ---------- Download
    if (q.api === 'SYNO.FileStation.Download' && q.method === 'download') {
      const paths = [].concat(parsePathParam(q.path));
      const r = realPath(user, paths[0]);
      if (r.error) return err(res, r.error);
      if (!fs.existsSync(r.full) || fs.statSync(r.full).isDirectory()) {
        res.writeHead(404);
        return res.end();
      }
      const buf = fs.readFileSync(r.full);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(paths[0]))}"` });
      return res.end(buf);
    }

    // ---------- Upload (multipart)
    if (q.api === 'SYNO.FileStation.Upload' && q.method === 'upload' && bodyBuf) {
      const form = await new Response(bodyBuf, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const dest = form.get('path');
      const file = form.get('file');
      if (!dest || !file) return err(res, 1802);
      const r = realPath(user, dest);
      if (r.error) return err(res, r.error);
      if (form.get('create_parents') === 'true') fs.mkdirSync(r.full, { recursive: true });
      if (!fs.existsSync(r.full)) return err(res, 408);
      const target = path.join(r.full, file.name);
      if (fs.existsSync(target) && form.get('overwrite') !== 'true') return err(res, 1805);
      fs.writeFileSync(target, Buffer.from(await file.arrayBuffer()));
      return ok(res, { blSkip: false, file: file.name, pid: 1, progress: 1 });
    }

    return err(res, 103);
  })
  .listen(PORT, () => console.log(`Mock Synology DSM di http://localhost:${PORT} (data: ${ROOT})`));
