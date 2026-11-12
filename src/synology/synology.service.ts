import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto.util';
import { SynologyClient, SynologyError, SynoFile } from './synology.client';
import { extractText, isSupported, mimeOf, SUPPORTED_EXT } from './extract';

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export interface ExtractedFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  text: string;
  truncated: boolean;
}

/**
 * Koneksi Synology per pengguna. Setiap orang login dengan akun DSM-nya sendiri, sehingga
 * Umira hanya bisa membuka folder yang memang boleh diakses orang tersebut.
 */
@Injectable()
export class SynologyService {
  private readonly logger = new Logger(SynologyService.name);
  readonly client: SynologyClient | null;
  readonly maxBytes = Number(process.env.SYNOLOGY_MAX_FILE_MB ?? 20) * 1048576;
  readonly maxChars = Number(process.env.SYNOLOGY_MAX_CHARS_PER_FILE ?? 60000);
  readonly allowRemember = process.env.SYNOLOGY_ALLOW_REMEMBER_PASSWORD !== 'false';
  /** Lampiran folder: maksimal file yang dibaca & total karakter yang masuk ke konteks AI. */
  readonly folderMaxFiles = Number(process.env.SYNOLOGY_FOLDER_MAX_FILES ?? 25);
  readonly folderMaxChars = Number(process.env.SYNOLOGY_FOLDER_MAX_CHARS ?? 200000);
  /** batas subfolder yang ditelusuri saat melampirkan folder (±250 ms/folder di NAS, 4 paralel) */
  readonly folderMaxScan = Number(process.env.SYNOLOGY_FOLDER_MAX_SCAN ?? 120);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    const url = process.env.SYNOLOGY_URL?.trim();
    this.client = url ? new SynologyClient(url, process.env.SYNOLOGY_VERIFY_TLS !== 'false', process.env.SYNOLOGY_SESSION) : null;
    if (this.client) this.logger.log(`Integrasi Synology aktif → ${this.client.baseUrl}`);
  }

  get enabled() {
    return !!this.client;
  }

  private requireClient(): SynologyClient {
    if (!this.client) throw new BadRequestException('Integrasi Synology belum diaktifkan oleh admin (SYNOLOGY_URL).');
    return this.client;
  }

  /** Ubah SynologyError menjadi HTTP error yang ramah. */
  private toHttp(e: unknown): never {
    if (!(e instanceof SynologyError)) throw e;
    const body = { message: e.message, code: e.kind };
    switch (e.kind) {
      case 'auth':
      case 'otp_required':
      case 'otp_invalid':
      case 'password_expired':
      case 'disabled':
        throw new BadRequestException(body);
      case 'session_expired':
        throw new BadRequestException({ message: 'Sesi Synology Anda sudah berakhir. Hubungkan ulang di halaman Profil.', code: 'session_expired' });
      case 'permission':
      case 'blocked':
        throw new ForbiddenException(body);
      case 'not_found':
        throw new NotFoundException(body);
      case 'too_large':
        throw new PayloadTooLargeException(body);
      case 'network':
        throw new ServiceUnavailableException(body);
      default:
        throw new BadRequestException(body);
    }
  }

  // ------------------------------------------------------------------ koneksi

  async status(userId: string) {
    const link = await this.prisma.synologyLink.findUnique({ where: { userId } });
    const universalSearch = this.client ? await this.client.finderAvailable().catch(() => false) : false;
    return {
      universalSearch,
      folderMaxFiles: this.folderMaxFiles,
      enabled: this.enabled,
      nasHost: this.client ? new URL(this.client.baseUrl).host : null,
      allowRemember: this.allowRemember,
      supportedExtensions: SUPPORTED_EXT,
      maxFileMb: this.maxBytes / 1048576,
      connected: !!link && link.status === 'connected',
      status: link?.status ?? 'disconnected',
      account: link?.account ?? null,
      remember: !!link?.passwordEncrypted,
      connectedAt: link?.updatedAt ?? null,
    };
  }

  async connect(userId: string, account: string, password: string, otp: string | undefined, remember: boolean, ip?: string) {
    const client = this.requireClient();
    const existing = await this.prisma.synologyLink.findUnique({ where: { userId } });
    const deviceId = existing?.deviceIdEncrypted && existing.account === account ? decryptSecret(existing.deviceIdEncrypted) : undefined;
    let r: { sid: string; deviceId?: string };
    try {
      r = await client.login(account, password, { otp, deviceId });
    } catch (e) {
      this.toHttp(e);
    }
    const data = {
      account,
      sidEncrypted: encryptSecret(r.sid),
      deviceIdEncrypted: r.deviceId ? encryptSecret(r.deviceId) : existing?.account === account ? existing?.deviceIdEncrypted : null,
      passwordEncrypted: remember && this.allowRemember ? encryptSecret(password) : null,
      status: 'connected',
      lastUsedAt: new Date(),
    };
    if (existing?.sidEncrypted) await client.logout(decryptSecret(existing.sidEncrypted));
    await this.prisma.synologyLink.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    await this.audit.log({ actorId: userId, action: 'synology.connect', targetType: 'synology', targetId: account, metadata: { remember: !!data.passwordEncrypted, twoFactor: !!otp }, ipAddress: ip });
    return this.status(userId);
  }

  async disconnect(userId: string, ip?: string) {
    const link = await this.prisma.synologyLink.findUnique({ where: { userId } });
    if (!link) return { ok: true };
    if (link.sidEncrypted && this.client) await this.client.logout(decryptSecret(link.sidEncrypted));
    await this.prisma.synologyLink.delete({ where: { userId } });
    // basis pengetahuan berasal dari hak akses akun ini → ikut dihapus
    await this.prisma.knowledgeChunk.deleteMany({ where: { userId } });
    await this.prisma.knowledgeIndex.deleteMany({ where: { userId } });
    await this.audit.log({ actorId: userId, action: 'synology.disconnect', targetType: 'synology', targetId: link.account, ipAddress: ip });
    return { ok: true };
  }

  /**
   * Jalankan operasi dengan sesi milik user. Bila sesi habis (default DSM: 7 hari) dan user memilih
   * "tetap tersambung", login ulang otomatis memakai password terenkripsi + device token 2FA.
   */
  async withSession<T>(userId: string, fn: (client: SynologyClient, sid: string) => Promise<T>): Promise<T> {
    const client = this.requireClient();
    const link = await this.prisma.synologyLink.findUnique({ where: { userId } });
    if (!link) throw new BadRequestException({ message: 'Akun Synology belum dihubungkan. Hubungkan di halaman Profil.', code: 'not_connected' });
    if (link.status !== 'connected' || !link.sidEncrypted) {
      throw new BadRequestException({ message: 'Sesi Synology Anda sudah berakhir. Hubungkan ulang di halaman Profil.', code: 'session_expired' });
    }
    try {
      const out = await fn(client, decryptSecret(link.sidEncrypted));
      await this.prisma.synologyLink.update({ where: { userId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
      return out;
    } catch (e) {
      if (!(e instanceof SynologyError) || e.kind !== 'session_expired') this.toHttp(e);
      if (link.passwordEncrypted) {
        let fresh: { sid: string } | null = null;
        try {
          fresh = await client.login(link.account, decryptSecret(link.passwordEncrypted), {
            deviceId: link.deviceIdEncrypted ? decryptSecret(link.deviceIdEncrypted) : undefined,
          });
        } catch (err) {
          if (!(err instanceof SynologyError)) throw err;
          this.logger.warn(`Login ulang Synology gagal untuk user ${userId}: ${err.message}`);
        }
        if (fresh) {
          await this.prisma.synologyLink.update({ where: { userId }, data: { sidEncrypted: encryptSecret(fresh.sid), status: 'connected', lastUsedAt: new Date() } });
          this.logger.log(`Sesi Synology user ${userId} diperbarui otomatis.`);
          try {
            return await fn(client, fresh.sid);
          } catch (err) {
            this.toHttp(err);
          }
        }
      }
      await this.prisma.synologyLink.update({ where: { userId }, data: { status: 'expired', sidEncrypted: null } });
      throw new BadRequestException({ message: 'Sesi Synology Anda sudah berakhir. Hubungkan ulang di halaman Profil.', code: 'session_expired' });
    }
  }

  // ------------------------------------------------------------------ file

  private safePath(p: string) {
    const path = (p ?? '').trim();
    if (!path.startsWith('/') || path.split('/').some((seg) => seg === '..') || path.length > 1024) {
      throw new BadRequestException('Path Synology tidak valid.');
    }
    return path.replace(/\/+$/, '') || '/';
  }

  private decorate(files: SynoFile[]) {
    return files.map((f) => ({ ...f, supported: !f.isdir && isSupported(f.name), tooLarge: !f.isdir && (f.size ?? 0) > this.maxBytes }));
  }

  async browse(userId: string, path?: string, offset = 0, limit = 200) {
    if (!path || path === '/') {
      const shares = await this.withSession(userId, (c, sid) => c.listShares(sid));
      return { path: '/', total: shares.length, files: this.decorate(shares) };
    }
    const folder = this.safePath(path);
    const r = await this.withSession(userId, (c, sid) => c.list(sid, folder, offset, limit));
    // folder dulu, lalu file
    const files = this.decorate(r.files).sort((a, b) => Number(b.isdir) - Number(a.isdir) || a.name.localeCompare(b.name));
    return { path: folder, total: r.total, files };
  }

  async search(userId: string, path: string, q: string) {
    const folder = this.safePath(path);
    const query = q.trim();
    if (query.length < 2) throw new BadRequestException('Kata kunci minimal 2 huruf.');
    const r = await this.withSession(userId, (c, sid) => c.search(sid, folder, `*${query}*`, 100));
    return { path: folder, q: query, finished: r.finished, files: this.decorate(r.files) };
  }

  /** Download + ekstraksi teks satu file (untuk lampiran chat). */
  async extract(userId: string, path: string): Promise<ExtractedFile> {
    const p = this.safePath(path);
    const name = p.split('/').pop() ?? p;
    if (!isSupported(name)) throw new BadRequestException(`Format file "${name}" belum didukung. Didukung: ${SUPPORTED_EXT.join(', ')}.`);
    const buf = await this.withSession(userId, (c, sid) => c.download(sid, p, this.maxBytes));
    try {
      const { text, truncated } = await extractText(name, buf, this.maxChars);
      return { path: p, name, size: buf.length, mimeType: mimeOf(name), text, truncated };
    } catch (e) {
      throw new BadRequestException(`Gagal membaca isi "${name}": ${e?.message ?? e}`);
    }
  }

  // ------------------------------------------------------------------ folder

  /** hasil penelusuran disimpan 2 menit: pratinjau lalu kirim pesan tidak perlu menelusuri dua kali */
  private readonly walkCache = new Map<string, { at: number; r: Awaited<ReturnType<SynologyClient['walk']>> }>();

  private async walkFolder(client: SynologyClient, sid: string, folder: string, userId: string) {
    const key = `${userId}:${folder}`;
    const hit = this.walkCache.get(key);
    let r = hit && Date.now() - hit.at < 120_000 ? hit.r : null;
    if (!r) {
      r = await client.walk(sid, folder, { maxEntries: 3000, maxFolders: this.folderMaxScan });
      for (const [k, v] of this.walkCache) if (Date.now() - v.at > 120_000) this.walkCache.delete(k);
      this.walkCache.set(key, { at: Date.now(), r });
    }
    // file terbaru dulu — biasanya paling relevan untuk pertanyaan sehari-hari
    const readable = r.files
      .filter((f) => isSupported(f.name) && (f.size ?? 0) <= this.maxBytes && (f.size ?? 1) > 0)
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.path.localeCompare(b.path));
    return { ...r, readable };
  }

  private requireFolder(path: string) {
    const folder = this.safePath(path);
    if (folder === '/' || folder.split('/').length < 2) throw new BadRequestException('Pilih folder di dalam shared folder.');
    return folder;
  }

  /** Pratinjau sebelum melampirkan folder: berapa file yang ada & mana saja yang akan dibaca AI. */
  async folderPreview(userId: string, path: string) {
    const folder = this.requireFolder(path);
    const r = await this.withSession(userId, (c, sid) => this.walkFolder(c, sid, folder, userId));
    const pick = r.readable.slice(0, this.folderMaxFiles);
    return {
      path: folder,
      name: folder.split('/').pop(),
      totalFiles: r.files.length,
      readableFiles: r.readable.length,
      willRead: pick.length,
      maxFiles: this.folderMaxFiles,
      scanTruncated: r.truncated,
      files: pick.map((f) => ({ name: f.name, path: f.path, size: f.size, mtime: f.mtime })),
    };
  }

  /**
   * Baca seluruh folder (rekursif) untuk lampiran chat. Anggaran karakter dibagi rata ke file yang
   * dibaca, sehingga 25 file tetap muat di konteks model. Ditambah satu "daftar isi" berisi semua
   * nama file agar AI tahu file apa saja yang ada walau tidak semuanya dibaca.
   */
  async extractFolder(userId: string, path: string): Promise<ExtractedFile[]> {
    const folder = this.requireFolder(path);
    const out = await this.withSession(userId, async (c, sid) => {
      const r = await this.walkFolder(c, sid, folder, userId);
      const pick = r.readable.slice(0, this.folderMaxFiles);
      const results: ExtractedFile[] = [];
      const skipped: string[] = [];
      let budget = this.folderMaxChars;
      for (let i = 0; i < pick.length; i++) {
        const f = pick[i];
        const share = Math.max(2000, Math.min(this.maxChars, Math.floor(budget / (pick.length - i))));
        try {
          const buf = await c.download(sid, f.path, this.maxBytes);
          const { text, truncated } = await extractText(f.name, buf, share);
          budget -= text.length;
          results.push({ path: f.path, name: f.name, size: buf.length, mimeType: mimeOf(f.name), text, truncated });
        } catch (e) {
          if (e instanceof SynologyError && e.kind === 'session_expired') throw e;
          skipped.push(`${f.path} (${e?.message ?? 'gagal dibaca'})`);
        }
      }
      const rel = (p: string) => p.slice(folder.length + 1);
      const readSet = new Set(results.map((x) => x.path));
      const lines = r.files.slice(0, 400).map((f) => `${readSet.has(f.path) ? '[dibaca] ' : ''}${rel(f.path)}${f.size ? ` (${fmtSize(f.size)})` : ''}`);
      const listing = [
        `Folder: ${folder}`,
        `Total file: ${r.files.length}${r.truncated ? '+ (folder sangat besar — penelusuran dibatasi)' : ''} · dibaca AI: ${results.length} (maks. ${this.folderMaxFiles}, file terbaru diutamakan)`,
        skipped.length ? `Gagal dibaca: ${skipped.join('; ')}` : '',
        '',
        ...lines,
        r.files.length > 400 ? `… dan ${r.files.length - 400} file lain` : '',
      ]
        .filter((l, i) => l !== '' || i === 3)
        .join('\n');
      return [
        { path: folder, name: `Daftar isi folder ${folder.split('/').pop()}`, size: 0, mimeType: 'text/x-folder-listing', text: listing, truncated: r.truncated },
        ...results,
      ];
    });
    await this.audit.log({ actorId: userId, action: 'synology.folder', targetType: 'synology', targetId: folder, metadata: { files: out.length - 1 } });
    return out;
  }

  // ------------------------------------------------------------------ universal search

  /** Cari nama & isi file lewat indeks Universal Search DSM (seluruh NAS yang boleh diakses user). */
  async contentSearch(userId: string, q: string, path?: string) {
    const client = this.requireClient();
    const query = q.trim();
    if (query.length < 2) throw new BadRequestException('Kata kunci minimal 2 huruf.');
    if (!(await client.finderAvailable().catch(() => false))) {
      throw new BadRequestException({ message: 'Universal Search belum terpasang di NAS. Gunakan pencarian nama file.', code: 'finder_unavailable' });
    }
    const scope = path && path !== '/' ? this.safePath(path) : null;
    const [r, folders] = await this.withSession(userId, (c, sid) =>
      Promise.all([c.finderSearch(sid, query, 0, scope ? 200 : 100), c.finderFolders(sid).catch(() => [])]),
    );
    const files = scope ? r.files.filter((f) => f.path === scope || f.path.startsWith(`${scope}/`)) : r.files;
    return {
      q: query,
      path: scope ?? '/',
      total: scope ? files.length : r.total,
      // isi dokumen hanya bisa dicari pada folder yang "Indeks konten file"-nya diaktifkan admin NAS
      contentIndexedFolders: folders.filter((f) => f.content).map((f) => f.path),
      files: this.decorate(files.slice(0, 100)).map((f, i) => ({ ...f, score: files[i]?.score })),
    };
  }

  async saveText(userId: string, folder: string, filename: string, content: string, ip?: string) {
    const dir = this.safePath(folder);
    if (dir === '/') throw new BadRequestException('Pilih folder di dalam shared folder.');
    const clean = filename.trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150) || 'jawaban-umira-ai.md';
    const name = /\.(md|txt)$/i.test(clean) ? clean : `${clean}.md`;
    await this.withSession(userId, (c, sid) => c.upload(sid, dir, name, Buffer.from(content, 'utf8'), name.endsWith('.txt') ? 'text/plain' : 'text/markdown'));
    await this.audit.log({ actorId: userId, action: 'synology.save', targetType: 'synology', targetId: `${dir}/${name}`, ipAddress: ip });
    return { ok: true, path: `${dir}/${name}` };
  }
}
