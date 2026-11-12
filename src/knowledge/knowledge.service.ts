import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { extractText, isSupported, mimeOf } from '../synology/extract';
import { SynologyError, SynoFile } from '../synology/synology.client';
import { ExtractedFile, SynologyService } from '../synology/synology.service';
import { chunkText } from './chunk';
import { dot, EmbeddingService } from './embedding.service';

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export interface KnowledgeHit {
  chunkId: string;
  indexId: string;
  fileId: string;
  name: string;
  path: string;
  ordinal: number;
  text: string;
  score: number;
}

/**
 * Basis pengetahuan (RAG) per pengguna.
 *  - Pengguna memilih folder Synology → job latar menelusuri, mengekstrak, memecah & (opsional) meng-embed isinya.
 *  - Semua akses NAS memakai sesi DSM milik pengguna itu sendiri; hasilnya hanya bisa dicari olehnya.
 *  - Indeks diperbarui berkala (inkremental: hanya file yang berubah) dan dihapus saat Synology diputus.
 *  - Pencarian hibrida: FULLTEXT (kata kunci) + cosine embedding bila dikonfigurasi, digabung dengan RRF.
 */
@Injectable()
export class KnowledgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Knowledge');
  readonly maxIndexes = env('RAG_MAX_INDEXES_PER_USER', 10);
  readonly maxFiles = env('RAG_MAX_FILES_PER_INDEX', 2000);
  readonly maxCharsPerFile = env('RAG_MAX_CHARS_PER_FILE', 300_000);
  readonly refreshHours = env('RAG_REFRESH_HOURS', 24);
  readonly topK = env('RAG_TOP_K', 8);
  readonly contextChars = env('RAG_CONTEXT_CHARS', 14_000);
  readonly maxVectorScan = env('RAG_MAX_VECTOR_SCAN', 60_000);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopping = false;
  /** id indeks yang sedang dikerjakan → dipakai untuk membatalkan saat indeks dihapus */
  private current: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly synology: SynologyService,
    private readonly embeddings: EmbeddingService,
    private readonly audit: AuditService,
  ) {}

  get enabled() {
    return this.synology.enabled && process.env.RAG_ENABLED !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) return;
    // job yang terputus karena restart → antrikan ulang
    await this.prisma.knowledgeIndex.updateMany({ where: { status: 'indexing' }, data: { status: 'queued' } }).catch(() => undefined);
    this.timer = setInterval(() => void this.tick(), env('RAG_WORKER_INTERVAL_MS', 10_000));
    this.logger.log(`Basis pengetahuan aktif · pencarian ${this.embeddings.enabled ? `hibrida (embedding: ${this.embeddings.model})` : 'kata kunci (FULLTEXT)'}`);
  }

  onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ API pengguna

  config() {
    return {
      enabled: this.enabled,
      semantic: this.embeddings.enabled,
      embeddingModel: this.embeddings.model || null,
      embeddingError: this.embeddings.lastError,
      maxIndexes: this.maxIndexes,
      maxFilesPerIndex: this.maxFiles,
      refreshHours: this.refreshHours,
    };
  }

  private requireEnabled() {
    if (!this.enabled) throw new BadRequestException('Basis pengetahuan belum diaktifkan (butuh integrasi Synology).');
  }

  async list(userId: string) {
    const indexes = await this.prisma.knowledgeIndex.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, path: true, name: true, status: true, progress: true, fileCount: true, chunkCount: true,
        skippedCount: true, error: true, autoRefresh: true, lastIndexedAt: true, createdAt: true,
      },
    });
    return { ...this.config(), indexes };
  }

  async create(userId: string, rawPath: string, ip?: string) {
    this.requireEnabled();
    const path = rawPath.trim().replace(/\/+$/, '');
    if (!path.startsWith('/') || path.split('/').length < 2 || path.split('/').includes('..')) throw new BadRequestException('Pilih folder di dalam shared folder.');
    const count = await this.prisma.knowledgeIndex.count({ where: { userId } });
    if (count >= this.maxIndexes) throw new BadRequestException(`Maksimal ${this.maxIndexes} folder per pengguna. Hapus salah satu dulu.`);
    // pastikan folder ada & boleh diakses user (sekaligus memvalidasi sesi Synology)
    await this.synology.browse(userId, path, 0, 1);
    const pathHash = sha(path);
    const exists = await this.prisma.knowledgeIndex.findUnique({ where: { userId_pathHash: { userId, pathHash } } });
    if (exists) throw new BadRequestException('Folder ini sudah ada di basis pengetahuan Anda.');
    // folder induk / anak yang sudah diindeks → tumpang-tindih, tolak agar hasil tidak dobel
    const others = await this.prisma.knowledgeIndex.findMany({ where: { userId }, select: { path: true } });
    const clash = others.find((o) => path.startsWith(`${o.path}/`) || o.path.startsWith(`${path}/`));
    if (clash) throw new BadRequestException(`Folder ini tumpang-tindih dengan "${clash.path}" yang sudah diindeks.`);
    const idx = await this.prisma.knowledgeIndex.create({ data: { userId, path, pathHash, name: path.split('/').pop() || path } });
    await this.audit.log({ actorId: userId, action: 'knowledge.add', targetType: 'knowledge', targetId: path, ipAddress: ip });
    setImmediate(() => void this.tick());
    return idx;
  }

  private async own(userId: string, id: string) {
    const idx = await this.prisma.knowledgeIndex.findFirst({ where: { id, userId } });
    if (!idx) throw new NotFoundException('Folder basis pengetahuan tidak ditemukan');
    return idx;
  }

  async reindex(userId: string, id: string) {
    const idx = await this.own(userId, id);
    if (idx.status === 'indexing' || idx.status === 'queued') return idx;
    const r = await this.prisma.knowledgeIndex.update({ where: { id }, data: { status: 'queued', error: null, progress: 0 } });
    setImmediate(() => void this.tick());
    return r;
  }

  async update(userId: string, id: string, data: { autoRefresh?: boolean }) {
    await this.own(userId, id);
    return this.prisma.knowledgeIndex.update({ where: { id }, data: { autoRefresh: data.autoRefresh } });
  }

  async remove(userId: string, id: string, ip?: string) {
    const idx = await this.own(userId, id);
    if (this.current === id) this.current = null; // sinyal batal ke job yang sedang jalan
    await this.prisma.knowledgeChunk.deleteMany({ where: { indexId: id } });
    await this.prisma.knowledgeIndex.delete({ where: { id } });
    await this.audit.log({ actorId: userId, action: 'knowledge.remove', targetType: 'knowledge', targetId: idx.path, ipAddress: ip });
    return { ok: true };
  }

  // ------------------------------------------------------------------ pencarian

  async search(userId: string, query: string, indexIds?: string[], k = this.topK): Promise<KnowledgeHit[]> {
    const q = query.trim().slice(0, 1000);
    if (q.length < 2) return [];
    const where = await this.prisma.knowledgeIndex.findMany({
      where: { userId, ...(indexIds?.length ? { id: { in: indexIds } } : {}), chunkCount: { gt: 0 } },
      select: { id: true },
    });
    const ids = where.map((w) => w.id);
    if (!ids.length) return [];

    const lists: string[][] = [];
    // 1) kata kunci — MySQL FULLTEXT (natural language) + cadangan boolean-prefix untuk kata pendek/parsial
    const kw = await this.prisma.$queryRaw<{ id: string; score: number }[]>`
      SELECT id, MATCH(text) AGAINST (${q} IN NATURAL LANGUAGE MODE) AS score
      FROM KnowledgeChunk
      WHERE userId = ${userId} AND indexId IN (${Prisma.join(ids)}) AND MATCH(text) AGAINST (${q} IN NATURAL LANGUAGE MODE)
      ORDER BY score DESC LIMIT 60`;
    lists.push(kw.map((r) => r.id));
    if (kw.length < k) {
      const terms = q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.slice(0, 8) ?? [];
      if (terms.length) {
        const bool = terms.map((t) => `${t}*`).join(' ');
        const pre = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM KnowledgeChunk
          WHERE userId = ${userId} AND indexId IN (${Prisma.join(ids)}) AND MATCH(text) AGAINST (${bool} IN BOOLEAN MODE)
          ORDER BY MATCH(text) AGAINST (${bool} IN BOOLEAN MODE) DESC LIMIT 60`;
        lists.push(pre.map((r) => r.id));
      }
    }

    // 2) semantik — cosine terhadap embedding potongan milik user (bila dikonfigurasi)
    if (this.embeddings.enabled) {
      try {
        const [qv] = await this.embeddings.embed([q]);
        const top: { id: string; s: number }[] = [];
        let cursor: string | undefined;
        let scanned = 0;
        while (scanned < this.maxVectorScan) {
          const rows = await this.prisma.knowledgeChunk.findMany({
            where: { userId, indexId: { in: ids }, embedding: { not: null } },
            select: { id: true, embedding: true },
            orderBy: { id: 'asc' },
            take: 2000,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          });
          if (!rows.length) break;
          for (const r of rows) {
            const s = dot(qv, EmbeddingService.fromBuffer(r.embedding!));
            if (top.length < 60 || s > top[top.length - 1].s) {
              top.push({ id: r.id, s });
              top.sort((a, b) => b.s - a.s);
              if (top.length > 60) top.pop();
            }
          }
          scanned += rows.length;
          cursor = rows[rows.length - 1].id;
        }
        lists.push(top.filter((t) => t.s > 0.2).map((t) => t.id));
      } catch (e) {
        this.logger.warn(`Pencarian semantik dilewati: ${e?.message ?? e}`);
      }
    }

    // 3) Reciprocal Rank Fusion
    const fused = new Map<string, number>();
    for (const l of lists) l.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank)));
    const best = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    if (!best.length) return [];
    const rows = await this.prisma.knowledgeChunk.findMany({
      where: { id: { in: best.map((b) => b[0]) }, userId },
      select: { id: true, indexId: true, fileId: true, ordinal: true, text: true, file: { select: { name: true, path: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return best
      .map(([id, score]) => {
        const r = byId.get(id);
        return r && { chunkId: id, indexId: r.indexId, fileId: r.fileId, name: r.file.name, path: r.file.path, ordinal: r.ordinal, text: r.text, score };
      })
      .filter(Boolean) as KnowledgeHit[];
  }

  /**
   * Potongan relevan untuk satu pertanyaan chat, dikelompokkan per file → dipakai sebagai lampiran
   * (source "knowledge") sehingga ikut tersimpan & terbaca ulang di riwayat percakapan.
   */
  async retrieveForChat(userId: string, query: string, indexIds?: string[]): Promise<ExtractedFile[]> {
    const hits = await this.search(userId, query, indexIds);
    const groups = new Map<string, KnowledgeHit[]>();
    let used = 0;
    for (const h of hits) {
      if (used + h.text.length > this.contextChars && used > 0) break;
      used += h.text.length;
      groups.set(h.fileId, [...(groups.get(h.fileId) ?? []), h]);
    }
    return [...groups.values()].map((hs) => {
      const sorted = hs.sort((a, b) => a.ordinal - b.ordinal);
      return {
        path: sorted[0].path,
        name: sorted[0].name,
        size: 0,
        mimeType: mimeOf(sorted[0].name),
        text: sorted.map((h) => `[potongan ${h.ordinal + 1}]\n${h.text}`).join('\n…\n'),
        truncated: true,
      };
    });
  }

  // ------------------------------------------------------------------ worker

  private async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      for (;;) {
        const due = new Date(Date.now() - this.refreshHours * 3_600_000);
        const next =
          (await this.prisma.knowledgeIndex.findFirst({ where: { status: 'queued' }, orderBy: { updatedAt: 'asc' } })) ??
          (await this.prisma.knowledgeIndex.findFirst({
            where: { autoRefresh: true, status: { in: ['ready', 'error'] }, OR: [{ lastIndexedAt: null }, { lastIndexedAt: { lt: due } }], updatedAt: { lt: due } },
            orderBy: { lastIndexedAt: 'asc' },
          }));
        if (!next || this.stopping) break;
        await this.run(next.id);
      }
    } catch (e) {
      this.logger.error(`Worker basis pengetahuan: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  private cancelled(id: string) {
    return this.current !== id || this.stopping;
  }

  /** Indeks satu folder secara inkremental. Error per file dicatat, error akses folder → status error. */
  async run(id: string) {
    const idx = await this.prisma.knowledgeIndex.findUnique({ where: { id } });
    if (!idx) return;
    this.current = id;
    const started = Date.now();
    await this.prisma.knowledgeIndex.update({ where: { id }, data: { status: 'indexing', progress: 0, error: null } });
    try {
      const walked = await this.synology.withSession(idx.userId, (c, sid) =>
        c.walk(sid, idx.path, { maxEntries: this.maxFiles * 4, maxFolders: 2000, maxDepth: 20 }),
      );
      const candidates = walked.files.filter((f) => isSupported(f.name)).slice(0, this.maxFiles);
      const existing = new Map(
        (await this.prisma.knowledgeFile.findMany({ where: { indexId: id }, select: { id: true, path: true, size: true, mtime: true, status: true } })).map((f) => [f.path, f]),
      );
      const seen = new Set<string>();
      let done = 0;
      for (const f of candidates) {
        if (this.cancelled(id)) return;
        seen.add(f.path);
        const old = existing.get(f.path);
        const unchanged = old && old.size === (f.size ?? 0) && old.mtime === (f.mtime ?? 0) && old.status !== 'error';
        if (!unchanged) {
          if (old) await this.prisma.knowledgeFile.delete({ where: { id: old.id } });
          await this.indexFile(idx.userId, id, f);
        }
        if (++done % 5 === 0) {
          await this.prisma.knowledgeIndex.update({ where: { id }, data: { progress: Math.round((done / Math.max(1, candidates.length)) * 100) } }).catch(() => undefined);
        }
      }
      if (this.cancelled(id)) return;
      const removed = [...existing.values()].filter((f) => !seen.has(f.path)).map((f) => f.id);
      if (removed.length) await this.prisma.knowledgeFile.deleteMany({ where: { id: { in: removed } } });

      const agg = await this.prisma.knowledgeFile.groupBy({ by: ['status'], where: { indexId: id }, _count: true, _sum: { chunkCount: true } });
      const ok = agg.find((a) => a.status === 'ok');
      const skipped = agg.filter((a) => a.status !== 'ok').reduce((s, a) => s + a._count, 0);
      const limited = walked.truncated || walked.files.filter((f) => isSupported(f.name)).length > this.maxFiles;
      await this.prisma.knowledgeIndex.update({
        where: { id },
        data: {
          status: 'ready',
          progress: 100,
          fileCount: ok?._count ?? 0,
          chunkCount: agg.reduce((s, a) => s + (a._sum.chunkCount ?? 0), 0),
          skippedCount: skipped,
          error: limited ? `Folder sangat besar — hanya ${this.maxFiles} file pertama yang diindeks.` : null,
          lastIndexedAt: new Date(),
        },
      });
      this.logger.log(`Indeks "${idx.path}" selesai: ${ok?._count ?? 0} file, ${((Date.now() - started) / 1000).toFixed(1)} dtk`);
    } catch (e) {
      const msg = errMessage(e);
      this.logger.warn(`Indeks "${idx.path}" gagal: ${msg}`);
      // tidak lagi punya akses → hapus isi yang sudah terindeks agar tidak bisa dicari lagi
      const lostAccess = e instanceof SynologyError ? ['permission', 'not_found'].includes(e.kind) : /izin|tidak ditemukan/i.test(msg);
      if (lostAccess) {
        await this.prisma.knowledgeChunk.deleteMany({ where: { indexId: id } });
        await this.prisma.knowledgeFile.deleteMany({ where: { indexId: id } });
      }
      await this.prisma.knowledgeIndex
        .update({ where: { id }, data: { status: 'error', error: msg.slice(0, 500), ...(lostAccess ? { fileCount: 0, chunkCount: 0 } : {}), lastIndexedAt: new Date() } })
        .catch(() => undefined);
    } finally {
      if (this.current === id) this.current = null;
    }
  }

  private async indexFile(userId: string, indexId: string, f: SynoFile) {
    const base = { indexId, path: f.path, name: f.name, size: f.size ?? 0, mtime: f.mtime ?? 0 };
    if ((f.size ?? 0) > this.synology.maxBytes) {
      await this.prisma.knowledgeFile.create({ data: { ...base, status: 'skipped', note: `Lebih dari ${this.synology.maxBytes / 1048576} MB` } });
      return;
    }
    let text: string;
    try {
      const buf = await this.synology.withSession(userId, (c, sid) => c.download(sid, f.path, this.synology.maxBytes));
      text = (await extractText(f.name, buf, this.maxCharsPerFile)).text;
    } catch (e) {
      if (e instanceof SynologyError && e.kind === 'session_expired') throw e;
      if (/sesi synology/i.test(errMessage(e))) throw e; // sesi habis & tidak bisa login ulang → hentikan job
      await this.prisma.knowledgeFile.create({ data: { ...base, status: 'error', note: errMessage(e).slice(0, 500) } });
      return;
    }
    if (/^\[PDF ini tidak memiliki teks/.test(text)) {
      await this.prisma.knowledgeFile.create({ data: { ...base, status: 'skipped', note: 'PDF hasil scan (tanpa teks)' } });
      return;
    }
    // judul file di awal tiap potongan membantu pencarian & membuat potongan bisa dipahami sendiri
    const parts = chunkText(text).map((t) => `${f.name}\n${t}`);
    let vectors: Float32Array[] = [];
    if (this.embeddings.enabled && parts.length) {
      vectors = await this.embeddings.embed(parts).catch((e) => {
        this.logger.warn(`Embedding "${f.name}" gagal, lanjut kata kunci saja: ${e?.message ?? e}`);
        return [];
      });
    }
    const file = await this.prisma.knowledgeFile.create({ data: { ...base, status: 'ok', chunkCount: parts.length } });
    for (let i = 0; i < parts.length; i += 200) {
      await this.prisma.knowledgeChunk.createMany({
        data: parts.slice(i, i + 200).map((t, j) => ({
          fileId: file.id,
          indexId,
          userId,
          ordinal: i + j,
          text: t,
          embedding: vectors[i + j] ? EmbeddingService.toBytes(vectors[i + j]) : null,
        })),
      });
    }
  }
}

function sha(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

function errMessage(e: any): string {
  const r = e?.response;
  const m = typeof r === 'object' ? r?.message : null;
  return String((Array.isArray(m) ? m.join(', ') : m) ?? e?.message ?? e);
}
