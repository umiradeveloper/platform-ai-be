import { ProviderAdapter, ResolvedProviderConfig, StreamEvent, StreamRequest } from './provider.types';
import { ensureOk, joinUrl, parseSse } from './sse.util';

export class GeminiAdapter implements ProviderAdapter {
  readonly type = 'GEMINI' as const;

  private headers(cfg: ResolvedProviderConfig) {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey ?? '', ...cfg.extraHeaders };
  }

  async *stream(req: StreamRequest, cfg: ResolvedProviderConfig): AsyncGenerator<StreamEvent> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const url = joinUrl(cfg.baseUrl, `v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`);
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(cfg),
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { maxOutputTokens: req.maxOutputTokens },
      }),
      signal: req.signal,
    });
    await ensureOk(res, 'Gemini');
    if (!res.body) return;

    for await (const rec of parseSse(res.body)) {
      let chunk: any;
      try {
        chunk = JSON.parse(rec.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? 'Gemini stream error');
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) if (p.text && !p.thought) yield { type: 'delta', text: p.text };
      if (chunk.usageMetadata) {
        yield {
          type: 'usage',
          inputTokens: chunk.usageMetadata.promptTokenCount,
          outputTokens: chunk.usageMetadata.candidatesTokenCount,
        };
      }
    }
  }

  async testConnection(cfg: ResolvedProviderConfig) {
    const res = await fetch(joinUrl(cfg.baseUrl, 'v1beta/models?pageSize=100'), { headers: this.headers(cfg), signal: AbortSignal.timeout(10_000) });
    await ensureOk(res, 'Gemini');
    const j: any = await res.json();
    const models = (j.models ?? []).map((m: any) => String(m.name).replace(/^models\//, ''));
    return { ok: true, detail: `Terhubung. ${models.length} model ditemukan.`, models };
  }
}
