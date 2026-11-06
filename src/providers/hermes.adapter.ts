import { ResolvedProviderConfig, StreamEvent, StreamRequest } from './provider.types';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';
import { ensureOk, joinUrl } from './sse.util';

/**
 * Adapter untuk Hermes Agent (Nous Research) milik sendiri.
 *
 * Hermes menyediakan API server OpenAI-compatible (default http://127.0.0.1:8642/v1)
 * yang diaktifkan dengan API_SERVER_ENABLED=true dan dilindungi API_SERVER_KEY (Bearer).
 * Saat streaming, selain chunk `chat.completion.chunk` standar Hermes mengirim event
 * `hermes.tool.progress` ketika agent mulai memakai tool (terminal, web search, file, dll).
 * Event ini diteruskan ke UI sebagai indikator aktivitas agent — tidak disimpan sebagai
 * teks jawaban.
 *
 * Mode sesi:
 *  - Default (stateless): seluruh riwayat percakapan dikirim di `messages`; Umira tetap
 *    menjadi sumber kebenaran riwayat (cocok dengan regenerate & context management).
 *  - Opsional: set extraHeaders {"X-Hermes-Session-Key": "..."} di konfigurasi provider bila
 *    ingin Hermes mengelompokkan sesi per instance.
 */
export class HermesAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super('HERMES');
  }

  protected label() {
    return 'Hermes Agent';
  }

  /**
   * Endpoint Hermes selalu di bawah /v1. Base URL dinormalisasi supaya isian seperti
   * "https://hermes.domain.com", ".../v1/", ".../v1/chat/completions" atau ".../v1/v1" tetap benar.
   */
  static normalizeBaseUrl(url: string): string {
    let u = url.trim().replace(/\/+$/, '');
    u = u.replace(/\/(chat\/completions|models|capabilities)$/i, '');
    u = u.replace(/(\/v1)+$/i, '');
    return `${u}/v1`;
  }

  protected base(cfg: ResolvedProviderConfig): string {
    return HermesAdapter.normalizeBaseUrl(cfg.baseUrl);
  }

  protected buildBody(req: StreamRequest): Record<string, unknown> {
    // Hermes mengatur sendiri panjang output & loop tool; cukup kirim pesan dan model (nama profil).
    return { model: req.model || 'hermes-agent', messages: req.messages, stream: true };
  }

  protected buildHeaders(cfg: ResolvedProviderConfig, req?: StreamRequest): Record<string, string> {
    const h = super.buildHeaders(cfg, req);
    // Idempotency-Key mencegah turn ganda bila request di-retry oleh proxy.
    if (req?.conversationId) h['Idempotency-Key'] = `umira-${req.conversationId}-${Date.now()}`;
    return h;
  }

  /**
   * Format asli Hermes (diverifikasi terhadap server Hermes Umira):
   *   event: hermes.tool.progress
   *   data: {"tool":"web_search","emoji":"🔍","label":"kurs USD ke IDR","toolCallId":"toolu_…","status":"running"}
   *   data: {"tool":"web_search","toolCallId":"toolu_…","status":"completed"}
   * Event "running" dan "completed" untuk toolCallId yang sama digabung di ChatService.
   */
  protected handleNamedEvent(event: string, data: string): StreamEvent | null {
    let p: any = {};
    try {
      p = JSON.parse(data);
    } catch {
      p = { label: data };
    }
    if (event === 'hermes.tool.progress') {
      const label = p.label ?? p.preview ?? p.message ?? p.description;
      return {
        type: 'tool',
        id: p.toolCallId ?? p.tool_call_id ?? p.id,
        tool: String(p.tool ?? p.tool_name ?? p.name ?? 'tool'),
        label: label ? String(label).slice(0, 300) : undefined,
        emoji: p.emoji ? String(p.emoji).slice(0, 8) : undefined,
        status: p.status ?? 'running',
      };
    }
    // Hermes bisa meminta persetujuan untuk tool berisiko (approval_events).
    // Persetujuan dilakukan di sisi Hermes; di sini cukup ditampilkan agar pengguna tahu agent sedang menunggu.
    if (event.startsWith('hermes.') && /approval/.test(event)) {
      return {
        type: 'tool',
        id: p.approvalId ?? p.id ?? p.toolCallId,
        tool: String(p.tool ?? 'approval'),
        label: `Menunggu persetujuan di Hermes${p.label ? `: ${String(p.label).slice(0, 200)}` : ''}`,
        emoji: '⏳',
        status: p.status ?? 'waiting',
      };
    }
    return null;
  }

  async testConnection(cfg: ResolvedProviderConfig) {
    // /v1/capabilities memastikan endpoint benar-benar Hermes dan mendukung streaming.
    try {
      const res = await fetch(joinUrl(this.base(cfg), 'capabilities'), {
        headers: this.buildHeaders(cfg),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const c: any = await res.json();
        const f = c.features ?? c; // versi Hermes baru menaruh flag di `features`
        const base = await super.testConnection(cfg).catch(() => ({ ok: true, detail: '', models: [] as string[] }));
        const yes = (v: unknown) => (v ? 'ya' : 'tidak');
        return {
          ok: true,
          detail:
            `Hermes Agent terhubung — model: ${c.model ?? 'hermes-agent'}, streaming: ${yes(f.chat_completions_streaming)}, ` +
            `event tool: ${yes(f.tool_progress_events)}, eksekusi tool: ${c.runtime?.tool_execution ?? '-'}.`,
          models: base.models,
        };
      }
    } catch {
      /* fallback ke /models */
    }
    try {
      const r = await super.testConnection(cfg);
      return { ...r, detail: `Hermes Agent terhubung. Model: ${r.models?.join(', ') || 'hermes-agent'}` };
    } catch (e) {
      // Sertakan URL yang dicoba agar salah alamat mudah dikenali
      throw new Error(`${e?.message ?? e} — URL: ${joinUrl(this.base(cfg), 'models')}`);
    }
  }

  /** Dipakai untuk menampilkan error yang lebih jelas jika Hermes belum jalan. */
  static explain(e: any): string {
    const msg = String(e?.cause?.code ?? e?.message ?? e);
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
      return 'Hermes Agent tidak dapat dihubungi. Pastikan `hermes gateway` berjalan dengan API_SERVER_ENABLED=true dan HERMES_BASE_URL benar.';
    }
    if (/\b404\b/.test(msg)) {
      return `Endpoint Hermes tidak ditemukan (404). Periksa Base URL — harus alamat API server Hermes, mis. https://hermes.domain.com/v1. ${msg}`;
    }
    if (/401|403/.test(msg)) return 'Hermes Agent menolak API key. Samakan HERMES_API_KEY dengan API_SERVER_KEY di ~/.hermes/.env.';
    return msg;
  }
}
