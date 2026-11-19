import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { mimeFor } from '../files/hermes-files.service';
import { extractText, isSupported } from '../synology/extract';

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export interface UploadDto {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  readable: boolean;
  truncated: boolean;
}

/**
 * Upload file langsung dari komputer pengguna (lampiran chat).
 *  - semua jenis file diterima & disimpan (bisa diunduh lagi dari chat)
 *  - teks diekstrak saat upload untuk PDF, Word, Excel, teks & kode; file lain dilampirkan
 *    sebagai keterangan saja (AI tahu file itu ada, tetapi tidak bisa membaca isinya)
 *  - hanya pemilik yang bisa memakai / mengunduh upload-nya
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger('Uploads');
  readonly storageDir = path.resolve(process.env.UPLOADS_DIR || 'storage/uploads');
  readonly maxBytes = env('UPLOAD_MAX_MB', 25) * 1024 * 1024;
  readonly maxFiles = env('UPLOAD_MAX_FILES', 20);
  readonly maxCharsPerFile = env('UPLOAD_MAX_CHARS_PER_FILE', 60_000);
  /** total teks lampiran upload per pesan — dibagi rata bila banyak file */
  readonly maxCharsPerMessage = env('UPLOAD_MAX_CHARS_PER_MESSAGE', 200_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  limits() {
    return { maxFileMb: this.maxBytes / 1048576, maxFiles: this.maxFiles };
  }

  async save(userId: string, files: { originalname: string; buffer: Buffer; size: number }[], names: string[], ip?: string): Promise<UploadDto[]> {
    if (!files?.length) throw new BadRequestException('Tidak ada file yang diunggah.');
    if (files.length > this.maxFiles) throw new BadRequestException(`Maksimal ${this.maxFiles} file sekali unggah.`);
    await mkdir(this.storageDir, { recursive: true });
    const out: UploadDto[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      // nama dari field `names` (UTF-8, boleh berisi subfolder "Folder/Sub/file.pdf"); multer membaca nama file sebagai latin1
      const raw = names[i] || Buffer.from(f.originalname, 'latin1').toString('utf8');
      const name = raw.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/').slice(-500) || 'file';
      if (f.size > this.maxBytes) throw new BadRequestException(`${name} lebih dari ${this.maxBytes / 1048576} MB.`);
      const base = name.split('/').pop()!;
      let text = '';
      let truncated = false;
      let readable = false;
      if (isSupported(base)) {
        try {
          ({ text, truncated } = await extractText(base, f.buffer, this.maxCharsPerFile));
          readable = !/^\[PDF ini tidak memiliki teks/.test(text);
        } catch (e) {
          text = `[Isi ${base} gagal dibaca: ${e?.message ?? e}]`;
        }
      }
      if (!readable && !text) text = `[File ${base} (${mimeFor(base)}, ${f.size} byte) dilampirkan; isinya tidak dapat dibaca AI.]`;
      const storageKey = `${randomUUID()}${path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
      await writeFile(path.join(this.storageDir, storageKey), f.buffer);
      const row = await this.prisma.upload.create({
        data: { userId, name, mimeType: mimeFor(base), size: f.size, storageKey, readable, text, truncated },
      });
      out.push({ id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, readable, truncated });
    }
    await this.audit.log({ actorId: userId, action: 'upload.create', targetType: 'upload', targetId: out.map((o) => o.id).join(','), ipAddress: ip, metadata: { files: out.length } });
    return out;
  }

  /** Lampiran untuk chat: anggaran teks dibagi rata ke file yang bisa dibaca. */
  async forChat(userId: string, ids: string[]) {
    const rows = await this.prisma.upload.findMany({ where: { id: { in: ids }, userId } });
    if (rows.length !== new Set(ids).size) throw new BadRequestException('Sebagian file upload tidak ditemukan. Unggah ulang file tersebut.');
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const readableCount = rows.filter((r) => r.readable).length || 1;
    const share = Math.max(4000, Math.floor(this.maxCharsPerMessage / readableCount));
    return rows.map((r) => {
      const cut = r.readable && r.text.length > share;
      return {
        path: `upload:${r.id}`,
        name: r.name,
        size: r.size,
        mimeType: r.mimeType,
        text: cut ? `${r.text.slice(0, share)}\n[… dipotong]` : r.text,
        truncated: r.truncated || cut,
      };
    });
  }

  async open(userId: string, id: string) {
    const u = await this.prisma.upload.findFirst({ where: { id, userId } });
    if (!u) throw new NotFoundException('File tidak ditemukan');
    const full = path.join(this.storageDir, u.storageKey);
    try {
      await stat(full);
    } catch {
      throw new NotFoundException('File sudah tidak tersedia di server');
    }
    return { file: u, stream: createReadStream(full) };
  }

  /** Hapus upload yang tidak jadi dikirim (tombol × di kolom pesan). Upload yang sudah terkirim tetap disimpan. */
  async remove(userId: string, id: string) {
    const u = await this.prisma.upload.findFirst({ where: { id, userId } });
    if (!u) return { ok: true };
    const used = await this.prisma.messageAttachment.count({ where: { path: `upload:${id}` } });
    if (used) return { ok: true };
    await this.prisma.upload.delete({ where: { id } });
    await unlink(path.join(this.storageDir, u.storageKey)).catch(() => undefined);
    return { ok: true };
  }
}
