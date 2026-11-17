import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../common/prisma.service';

export interface GeneratedFileDto {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  py: 'text/x-python',
  js: 'text/javascript',
  ts: 'text/plain',
  sql: 'text/plain',
  sh: 'text/plain',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  zip: 'application/zip',
};

export function mimeFor(name: string) {
  return MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

/**
 * File yang dibuat Hermes Agent untuk pengguna.
 *
 * Hermes API server tidak punya endpoint unduh file — file hasil tool tetap di disk server Hermes,
 * dan saat streaming penanda `MEDIA:/path` dikirim apa adanya. Maka:
 *  1. Hermes diminta (lewat system prompt) menyimpan file untuk pengguna di HERMES_OUTPUT_DIR
 *     dan menulis baris `MEDIA:/path/lengkap`.
 *  2. Setelah jawaban selesai, path di dalam folder itu diambil — langsung dari disk (mode `local`,
 *     Hermes satu server / folder di-mount) atau lewat `tools/hermes-file-relay.mjs` (mode `relay`).
 *  3. File disalin ke GENERATED_FILES_DIR dan bisa diunduh pemiliknya lewat GET /files/:id.
 *
 * Hanya path DI DALAM HERMES_OUTPUT_DIR yang diambil — mencegah file lain di server Hermes
 * (mis. ~/.hermes/.env) ikut terkirim walau AI menulis path-nya.
 */
@Injectable()
export class HermesFilesService {
  private readonly logger = new Logger('HermesFiles');
  /** folder output sebagaimana dilihat Hermes (dipakai di prompt & validasi path) */
  readonly outputDir = (process.env.HERMES_OUTPUT_DIR ?? '').trim().replace(/\/+$/, '');
  /** folder yang sama sebagaimana dilihat backend ini (mode local; mis. hasil mount) */
  readonly localDir = (process.env.HERMES_OUTPUT_LOCAL_DIR ?? '').trim().replace(/\/+$/, '') || this.outputDir;
  readonly relayUrl = (process.env.HERMES_FILES_RELAY_URL ?? '').trim().replace(/\/+$/, '');
  readonly relayKey = process.env.HERMES_FILES_RELAY_KEY ?? '';
  readonly mode: 'off' | 'local' | 'relay';
  readonly storageDir = path.resolve(process.env.GENERATED_FILES_DIR || 'storage/generated');
  readonly maxBytes = env('HERMES_FILE_MAX_MB', 50) * 1024 * 1024;
  readonly maxPerMessage = env('HERMES_FILE_MAX_PER_MESSAGE', 10);

  constructor(private readonly prisma: PrismaService) {
    const m = (process.env.HERMES_FILES_MODE ?? '').trim().toLowerCase();
    this.mode = !this.outputDir || m === 'off' ? 'off' : m === 'local' || m === 'relay' ? m : this.relayUrl ? 'relay' : 'local';
    if (this.mode !== 'off') this.logger.log(`File hasil Hermes aktif (${this.mode}) · folder ${this.outputDir}`);
  }

  get enabled() {
    return this.mode !== 'off';
  }

  /** Instruksi tambahan untuk system prompt saat model = Hermes. */
  instruction() {
    if (!this.enabled) return '';
    return [
      'Jika Anda membuat file untuk pengguna (dokumen, spreadsheet, presentasi, gambar, kode, dll.):',
      `- simpan file tersebut di folder ${this.outputDir} (buat subfolder bila perlu, gunakan nama file yang jelas);`,
      '- setelah file selesai dibuat, tulis di baris tersendiri: MEDIA:<path lengkap file>, satu baris per file;',
      '- jangan menulis isi file biner di jawaban — aplikasi Umira AI akan menampilkan tombol unduh untuk setiap baris MEDIA.',
    ].join('\n');
  }

  /** Cari path file di jawaban: baris `MEDIA:` + path di dalam folder output (juga dari label tool). */
  extractRefs(text: string, extra: string[] = []): string[] {
    if (!this.enabled) return [];
    const found: string[] = [];
    const clean = (p: string) => p.trim().replace(/^[`'"<(]+|[`'">),.;:]+$/g, '');
    for (const m of text.matchAll(/^[ \t>*-]*MEDIA:\s*(.+?)\s*$/gm)) found.push(clean(m[1]));
    const esc = this.outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${esc}/[^\\s\`'"<>()\\[\\]{}|]+`, 'g');
    for (const src of [text, ...extra]) for (const m of src.matchAll(re)) found.push(clean(m[0]));
    const out: string[] = [];
    for (const f of found) {
      const p = path.posix.normalize(f);
      if (!p.startsWith(`${this.outputDir}/`) || p.split('/').includes('..') || p.endsWith('/')) continue;
      if (!path.posix.extname(p)) continue; // folder / bukan file
      if (!out.includes(p)) out.push(p);
    }
    return out.slice(0, this.maxPerMessage);
  }

  /** Hapus baris `MEDIA:` dari teks jawaban (tombol unduh menggantikannya). */
  stripMedia(text: string) {
    return text
      .replace(/^[ \t>*-]*MEDIA:\s*.+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async fetchBytes(p: string): Promise<Buffer> {
    if (this.mode === 'local') {
      const local = path.join(this.localDir, path.posix.relative(this.outputDir, p));
      const [real, root] = await Promise.all([realpath(local), realpath(this.localDir)]);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error('di luar folder output');
      const st = await stat(real);
      if (!st.isFile()) throw new Error('bukan file');
      if (st.size > this.maxBytes) throw new Error(`lebih dari ${this.maxBytes / 1048576} MB`);
      return readFile(real);
    }
    const res = await fetch(`${this.relayUrl}/file?path=${encodeURIComponent(p)}`, {
      headers: this.relayKey ? { Authorization: `Bearer ${this.relayKey}` } : {},
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => {
      throw new Error(`relay tidak dapat dihubungi (${e?.cause?.code ?? e?.message})`);
    });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > this.maxBytes) throw new Error(`lebih dari ${this.maxBytes / 1048576} MB`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > this.maxBytes) throw new Error(`lebih dari ${this.maxBytes / 1048576} MB`);
    return buf;
  }

  /** Ambil & simpan file; mengembalikan yang berhasil + daftar yang gagal (nama + alasan). */
  async collect(userId: string, messageId: string, refs: string[]) {
    const files: GeneratedFileDto[] = [];
    const failed: { name: string; reason: string }[] = [];
    if (!refs.length) return { files, failed };
    await mkdir(this.storageDir, { recursive: true });
    for (const ref of refs) {
      const name = path.posix.basename(ref);
      try {
        const buf = await this.fetchBytes(ref);
        const storageKey = `${randomUUID()}${path.extname(name).toLowerCase()}`;
        await writeFile(path.join(this.storageDir, storageKey), buf);
        const row = await this.prisma.generatedFile.create({
          data: { messageId, userId, name, mimeType: mimeFor(name), size: buf.length, sourcePath: ref, storageKey },
        });
        files.push({ id: row.id, name: row.name, mimeType: row.mimeType, size: row.size });
      } catch (e) {
        const reason = String(e?.code === 'ENOENT' ? 'file tidak ditemukan' : e?.message ?? e);
        this.logger.warn(`Gagal mengambil ${ref}: ${reason}`);
        failed.push({ name, reason });
      }
    }
    return { files, failed };
  }

  /** File milik user untuk diunduh. */
  async open(userId: string, id: string) {
    const f = await this.prisma.generatedFile.findFirst({ where: { id, userId } });
    if (!f) throw new NotFoundException('File tidak ditemukan');
    const full = path.join(this.storageDir, f.storageKey);
    try {
      await stat(full);
    } catch {
      throw new NotFoundException('File sudah tidak tersedia di server');
    }
    return { file: f, stream: createReadStream(full) };
  }

  async readAll(userId: string, id: string) {
    const f = await this.prisma.generatedFile.findFirst({ where: { id, userId } });
    if (!f) throw new NotFoundException('File tidak ditemukan');
    try {
      return { file: f, buf: await readFile(path.join(this.storageDir, f.storageKey)) };
    } catch {
      throw new NotFoundException('File sudah tidak tersedia di server');
    }
  }
}
