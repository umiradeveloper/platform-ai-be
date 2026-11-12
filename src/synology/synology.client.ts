import { Logger } from '@nestjs/common';
import { Agent, fetch as undiciFetch, FormData as UndiciFormData } from 'undici';

/**
 * Klien tipis untuk Synology DSM Web API (File Station).
 * Referensi: Synology File Station API Guide & DSM Login Web API Guide.
 *  - SYNO.API.Info   → menemukan path CGI & versi maksimum tiap API
 *  - SYNO.API.Auth   → login (sid), dukung 2FA (otp_code) + device token ("ingat perangkat")
 *  - SYNO.FileStation.List / Search / Download / Upload
 */

export type SynologyErrorKind =
  | 'auth' // username/password salah
  | 'disabled'
  | 'permission'
  | 'otp_required'
  | 'otp_invalid'
  | 'blocked'
  | 'password_expired'
  | 'session_expired'
  | 'not_found'
  | 'network'
  | 'too_large'
  | 'other';

export class SynologyError extends Error {
  constructor(
    readonly kind: SynologyErrorKind,
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

const AUTH_ERRORS: Record<number, [SynologyErrorKind, string]> = {
  400: ['auth', 'Username atau password Synology salah.'],
  401: ['disabled', 'Akun Synology dinonaktifkan.'],
  402: ['permission', 'Akun Synology tidak punya izin memakai File Station.'],
  403: ['otp_required', 'Akun ini memakai verifikasi 2 langkah — masukkan kode OTP.'],
  404: ['otp_invalid', 'Kode OTP salah atau kedaluwarsa.'],
  406: ['otp_required', 'Akun ini wajib verifikasi 2 langkah — masukkan kode OTP.'],
  407: ['blocked', 'Alamat IP server Umira diblokir oleh Synology (auto block). Hubungi admin NAS.'],
  408: ['password_expired', 'Password Synology kedaluwarsa. Ganti password di DSM terlebih dahulu.'],
  409: ['password_expired', 'Password Synology kedaluwarsa. Ganti password di DSM terlebih dahulu.'],
  410: ['password_expired', 'Password Synology harus diganti. Ganti password di DSM terlebih dahulu.'],
};

const COMMON_ERRORS: Record<number, [SynologyErrorKind, string]> = {
  105: ['permission', 'Tidak punya izin untuk mengakses lokasi ini di Synology.'],
  106: ['session_expired', 'Sesi Synology habis.'],
  107: ['session_expired', 'Sesi Synology terputus karena login ganda.'],
  119: ['session_expired', 'Sesi Synology tidak ditemukan.'],
  400: ['other', 'Parameter tidak valid.'],
  401: ['other', 'Terjadi kesalahan pada File Station.'],
  402: ['other', 'Sistem Synology sedang sibuk.'],
  407: ['permission', 'Operasi tidak diizinkan.'],
  408: ['not_found', 'File atau folder tidak ditemukan di Synology.'],
  414: ['other', 'File atau folder sudah ada.'],
  416: ['other', 'Kuota penyimpanan tidak cukup.'],
  418: ['other', 'Nama atau path tidak valid.'],
  1800: ['other', 'Upload gagal: ukuran data tidak cocok.'],
  1802: ['other', 'Upload gagal: file tidak lengkap.'],
  1805: ['other', 'Upload gagal: file sudah ada.'],
};

interface ApiInfo {
  path: string;
  maxVersion: number;
}

export interface SynoFile {
  path: string;
  name: string;
  isdir: boolean;
  size?: number;
  mtime?: number;
}

export class SynologyClient {
  private readonly logger = new Logger('Synology');
  private info: Record<string, ApiInfo> | null = null;
  private infoAt = 0;
  private readonly dispatcher?: Agent;

  constructor(
    readonly baseUrl: string,
    verifyTls = true,
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    if (!verifyTls) this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  private async request(url: string, init: Parameters<typeof undiciFetch>[1] = {}, timeoutMs = 20_000) {
    try {
      return await undiciFetch(url, { ...init, dispatcher: this.dispatcher, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const cause = e?.cause?.code ?? e?.name ?? e?.message;
      throw new SynologyError('network', `Server Synology tidak dapat dihubungi (${cause}).`);
    }
  }

  /** SYNO.API.Info — path CGI tiap API berbeda antar versi DSM (auth.cgi vs entry.cgi). */
  private async api(name: string): Promise<ApiInfo> {
    if (!this.info || Date.now() - this.infoAt > 3_600_000) {
      const q = 'SYNO.API.Auth,SYNO.FileStation.List,SYNO.FileStation.Search,SYNO.FileStation.Download,SYNO.FileStation.Upload';
      const res = await this.request(`${this.baseUrl}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=${q}`);
      const j: any = await res.json().catch(() => null);
      if (!j?.success) throw new SynologyError('network', 'Alamat Synology tidak valid (SYNO.API.Info gagal). Periksa SYNOLOGY_URL.');
      this.info = j.data;
      this.infoAt = Date.now();
    }
    const a = this.info?.[name];
    if (!a) throw new SynologyError('other', `API ${name} tidak tersedia di NAS ini (File Station belum aktif?).`);
    return a;
  }

  private url(info: ApiInfo, params: Record<string, string | number | boolean | undefined>) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
    return `${this.baseUrl}/webapi/${info.path}?${qs.toString()}`;
  }

  private fail(code: number | undefined, auth = false): never {
    const table = auth ? { ...COMMON_ERRORS, ...AUTH_ERRORS } : COMMON_ERRORS;
    const [kind, msg] = (code != null && table[code]) || ['other', `Synology mengembalikan error ${code ?? '?'}.`];
    throw new SynologyError(kind, msg, code);
  }

  private async call(apiName: string, method: string, version: number, params: Record<string, any>, sid?: string) {
    const info = await this.api(apiName);
    const res = await this.request(this.url(info, { api: apiName, version: Math.min(version, info.maxVersion), method, ...params, _sid: sid }));
    const j: any = await res.json().catch(() => null);
    if (!j) throw new SynologyError('other', `Respons Synology tidak valid (HTTP ${res.status}).`);
    if (!j.success) this.fail(j.error?.code, apiName === 'SYNO.API.Auth');
    return j.data ?? {};
  }

  // ------------------------------------------------------------------ auth

  async login(account: string, password: string, opts: { otp?: string; deviceId?: string } = {}): Promise<{ sid: string; deviceId?: string }> {
    const info = await this.api('SYNO.API.Auth');
    const version = Math.min(info.maxVersion, 6); // v6+: device token untuk 2FA
    const data = await this.call(
      'SYNO.API.Auth',
      'login',
      version,
      {
        account,
        passwd: password,
        session: 'FileStation',
        format: 'sid',
        otp_code: opts.otp || undefined,
        enable_device_token: opts.otp ? 'yes' : undefined,
        device_name: opts.otp || opts.deviceId ? 'Umira AI' : undefined,
        device_id: opts.deviceId || undefined,
      },
    );
    if (!data.sid) throw new SynologyError('other', 'Login Synology tidak mengembalikan sesi.');
    return { sid: data.sid, deviceId: data.did || data.device_id || undefined };
  }

  async logout(sid: string) {
    try {
      await this.call('SYNO.API.Auth', 'logout', 1, { session: 'FileStation' }, sid);
    } catch {
      /* abaikan */
    }
  }

  // ------------------------------------------------------------------ file station

  async listShares(sid: string): Promise<SynoFile[]> {
    const d = await this.call('SYNO.FileStation.List', 'list_share', 2, { additional: '["time"]', sort_by: 'name' }, sid);
    return (d.shares ?? []).map((s: any) => ({ path: s.path, name: s.name, isdir: true, mtime: s.additional?.time?.mtime }));
  }

  async list(sid: string, folder: string, offset = 0, limit = 200): Promise<{ total: number; files: SynoFile[] }> {
    const d = await this.call(
      'SYNO.FileStation.List',
      'list',
      2,
      { folder_path: JSON.stringify(folder), offset, limit, sort_by: 'name', additional: '["size","time"]' },
      sid,
    );
    return { total: d.total ?? 0, files: (d.files ?? []).map(toFile) };
  }

  /** Pencarian rekursif: start → polling list sampai selesai (maks ~10 detik) → stop & clean. */
  async search(sid: string, folder: string, pattern: string, limit = 100): Promise<{ files: SynoFile[]; finished: boolean }> {
    const start = await this.call('SYNO.FileStation.Search', 'start', 2, { folder_path: JSON.stringify([folder]), pattern, recursive: true }, sid);
    const taskid = start.taskid;
    let files: SynoFile[] = [];
    let finished = false;
    try {
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
        const d = await this.call('SYNO.FileStation.Search', 'list', 2, { taskid, offset: 0, limit, additional: '["size","time"]' }, sid);
        files = (d.files ?? []).map(toFile);
        finished = !!d.finished;
        if (finished || files.length >= limit) break;
      }
    } finally {
      await this.call('SYNO.FileStation.Search', 'stop', 2, { taskid }, sid).catch(() => undefined);
      await this.call('SYNO.FileStation.Search', 'clean', 2, { taskid }, sid).catch(() => undefined);
    }
    return { files, finished };
  }

  /** Download satu file; dibatasi maxBytes agar file raksasa tidak memenuhi memori. */
  async download(sid: string, path: string, maxBytes: number): Promise<Buffer> {
    const info = await this.api('SYNO.FileStation.Download');
    const res = await this.request(
      this.url(info, { api: 'SYNO.FileStation.Download', version: Math.min(2, info.maxVersion), method: 'download', path: JSON.stringify([path]), mode: 'download', _sid: sid }),
      {},
      60_000,
    );
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const j: any = await res.json().catch(() => null);
      this.fail(j?.error?.code);
    }
    if (res.status === 404) throw new SynologyError('not_found', 'File tidak ditemukan di Synology.');
    if (!res.ok || !res.body) throw new SynologyError('other', `Download dari Synology gagal (HTTP ${res.status}).`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > maxBytes) throw new SynologyError('too_large', `File terlalu besar (${(len / 1048576).toFixed(1)} MB).`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new SynologyError('too_large', `File melebihi batas ${(maxBytes / 1048576).toFixed(0)} MB.`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Upload (multipart; bagian file wajib paling akhir). */
  async upload(sid: string, folder: string, filename: string, content: Buffer, mime = 'text/markdown') {
    const info = await this.api('SYNO.FileStation.Upload');
    const form = new UndiciFormData();
    form.append('path', folder);
    form.append('create_parents', 'true');
    form.append('overwrite', 'true');
    form.append('file', new Blob([new Uint8Array(content)], { type: mime }), filename);
    const res = await this.request(
      this.url(info, { api: 'SYNO.FileStation.Upload', version: Math.min(2, info.maxVersion), method: 'upload', _sid: sid }),
      { method: 'POST', body: form },
      60_000,
    );
    const j: any = await res.json().catch(() => null);
    if (!j?.success) this.fail(j?.error?.code);
  }
}

function toFile(f: any): SynoFile {
  return { path: f.path, name: f.name, isdir: !!f.isdir, size: f.additional?.size, mtime: f.additional?.time?.mtime };
}
