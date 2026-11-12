import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { decryptSecret, encryptSecret } from '../common/crypto.util';
import { SynologyClient, SynologyError, SynoFile } from './synology.client';
import { extractText, isSupported, mimeOf, SUPPORTED_EXT } from './extract';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    const url = process.env.SYNOLOGY_URL?.trim();
    this.client = url ? new SynologyClient(url, process.env.SYNOLOGY_VERIFY_TLS !== 'false') : null;
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
    return {
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
    await this.audit.log({ actorId: userId, action: 'synology.disconnect', targetType: 'synology', targetId: link.account, ipAddress: ip });
    return { ok: true };
  }

  /**
   * Jalankan operasi dengan sesi milik user. Bila sesi habis (default DSM: 7 hari) dan user memilih
   * "tetap tersambung", login ulang otomatis memakai password terenkripsi + device token 2FA.
   */
  private async withSession<T>(userId: string, fn: (client: SynologyClient, sid: string) => Promise<T>): Promise<T> {
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
