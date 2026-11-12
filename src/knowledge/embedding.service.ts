import { Injectable, Logger } from '@nestjs/common';
import { ProviderType } from '@prisma/client';
import { ProviderRegistry } from '../providers/provider.registry';
import { HermesAdapter } from '../providers/hermes.adapter';
import { joinUrl } from '../providers/sse.util';

/**
 * Embedding OPSIONAL untuk pencarian semantik (endpoint OpenAI-compatible `/embeddings`).
 * Tanpa konfigurasi, basis pengetahuan tetap jalan dengan pencarian kata kunci (MySQL FULLTEXT).
 *
 *   RAG_EMBEDDING_MODEL=text-embedding-3-small          (wajib untuk mengaktifkan)
 *   RAG_EMBEDDING_PROVIDER=OPENAI | OPENAI_COMPATIBLE | HERMES   → pakai base URL & API key provider itu
 *   atau RAG_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1 + RAG_EMBEDDING_API_KEY=...
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger('Embedding');
  readonly model = process.env.RAG_EMBEDDING_MODEL?.trim() || '';
  lastError: string | null = null;

  constructor(private readonly registry: ProviderRegistry) {}

  get enabled() {
    return !!this.model;
  }

  private async endpoint() {
    const type = process.env.RAG_EMBEDDING_PROVIDER?.trim().toUpperCase() as ProviderType | undefined;
    if (type) {
      const cfg = await this.registry.resolve(type);
      const base = type === 'HERMES' ? HermesAdapter.normalizeBaseUrl(cfg.baseUrl) : cfg.baseUrl;
      return { url: joinUrl(base, 'embeddings'), apiKey: cfg.apiKey, headers: cfg.extraHeaders ?? {} };
    }
    const base = process.env.RAG_EMBEDDING_BASE_URL?.trim() || 'https://api.openai.com/v1';
    return { url: joinUrl(base, 'embeddings'), apiKey: process.env.RAG_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || null, headers: {} };
  }

  /** Embedding banyak teks sekaligus (batch 64). Melempar error bila provider gagal. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.enabled || !texts.length) return [];
    const ep = await this.endpoint();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 8000));
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}), ...ep.headers },
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: AbortSignal.timeout(60_000),
      }).catch((e) => {
        throw new Error(`Provider embedding tidak dapat dihubungi (${e?.cause?.code ?? e?.message})`);
      });
      const j: any = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(j?.data)) {
        this.lastError = `Embedding gagal (HTTP ${res.status}): ${String(j?.error?.message ?? j?.error ?? '').slice(0, 200)}`;
        throw new Error(this.lastError);
      }
      const rows = [...j.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const r of rows) out.push(normalize(Float32Array.from(r.embedding as number[])));
    }
    this.lastError = null;
    return out;
  }

  static toBytes(v: Float32Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
  }

  static fromBuffer(b: Uint8Array): Float32Array {
    const copy = new Uint8Array(b); // salin agar offset ter-align 4 byte
    return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
  }
}

function normalize(v: Float32Array) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Vektor sudah dinormalisasi → cosine = dot product. */
export function dot(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
