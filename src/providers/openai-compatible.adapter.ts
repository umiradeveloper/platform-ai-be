import { ProviderType } from '@prisma/client';
import { ProviderAdapter, ResolvedProviderConfig, StreamEvent, StreamRequest } from './provider.types';
import { ensureOk, joinUrl, parseSse } from './sse.util';

/**
 * Adapter untuk API bergaya OpenAI Chat Completions.
 * Dipakai oleh: OpenAI resmi, server OpenAI-compatible (vLLM, Ollama, LiteLLM, dsb.)
 * dan sebagai basis HermesAdapter.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(readonly type: ProviderType = 'OPENAI') {}

  protected label(): string {
    return this.type === 'OPENAI' ? 'OpenAI' : 'OpenAI-compatible';
  }

  /** Base URL efektif (bisa dinormalisasi oleh subclass). */
  protected base(cfg: ResolvedProviderConfig): string {
    return cfg.baseUrl;
  }

  protected buildHeaders(cfg: ResolvedProviderConfig, _req?: StreamRequest): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...cfg.extraHeaders };
    if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
    return h;
  }

  protected buildBody(req: StreamRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.type === 'OPENAI') body.max_completion_tokens = req.maxOutputTokens;
    else body.max_tokens = req.maxOutputTokens;
    if (req.userId && this.type === 'OPENAI') body.user = req.userId;
    return body;
  }

  /** Hook untuk event SSE bernama (non-"message"), mis. hermes.tool.progress. */
  protected handleNamedEvent(_event: string, _data: string): StreamEvent | null {
    return null;
  }

  async *stream(req: StreamRequest, cfg: ResolvedProviderConfig): AsyncGenerator<StreamEvent> {
    const res = await fetch(joinUrl(this.base(cfg), 'chat/completions'), {
      method: 'POST',
      headers: this.buildHeaders(cfg, req),
      body: JSON.stringify(this.buildBody(req)),
      signal: req.signal,
    });
    await ensureOk(res, this.label());
    if (!res.body) return;

    for await (const rec of parseSse(res.body)) {
      if (rec.event && rec.event !== 'message') {
        const ev = this.handleNamedEvent(rec.event, rec.data);
        if (ev) yield ev;
        continue;
      }
      if (rec.data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(rec.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? 'Provider stream error');
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text.length) yield { type: 'delta', text };
      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? chunk.usage.input_tokens,
          outputTokens: chunk.usage.completion_tokens ?? chunk.usage.output_tokens,
        };
      }
    }
  }

  async testConnection(cfg: ResolvedProviderConfig) {
    const res = await fetch(joinUrl(this.base(cfg), 'models'), { headers: this.buildHeaders(cfg), signal: AbortSignal.timeout(10_000) });
    await ensureOk(res, this.label());
    const j: any = await res.json().catch(() => ({}));
    const models: string[] = Array.isArray(j?.data) ? j.data.map((m: any) => m.id).slice(0, 50) : [];
    return { ok: true, detail: `Terhubung. ${models.length} model ditemukan.`, models };
  }
}
