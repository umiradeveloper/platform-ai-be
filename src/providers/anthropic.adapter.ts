import { ProviderAdapter, ResolvedProviderConfig, StreamEvent, StreamRequest } from './provider.types';
import { ensureOk, joinUrl, parseSse } from './sse.util';

export class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'ANTHROPIC' as const;

  private headers(cfg: ResolvedProviderConfig) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      ...cfg.extraHeaders,
    };
  }

  async *stream(req: StreamRequest, cfg: ResolvedProviderConfig): AsyncGenerator<StreamEvent> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    // Anthropic mensyaratkan role bergantian user/assistant — gabungkan pesan berurutan dengan role sama.
    const msgs: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      const last = msgs[msgs.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else msgs.push({ role: m.role, content: m.content });
    }
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();

    const res = await fetch(joinUrl(cfg.baseUrl, 'v1/messages'), {
      method: 'POST',
      headers: this.headers(cfg),
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: system || undefined,
        messages: msgs,
        stream: true,
      }),
      signal: req.signal,
    });
    await ensureOk(res, 'Anthropic');
    if (!res.body) return;

    for await (const rec of parseSse(res.body)) {
      let ev: any;
      try {
        ev = JSON.parse(rec.data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          yield { type: 'usage', inputTokens: ev.message?.usage?.input_tokens };
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'delta', text: ev.delta.text };
          break;
        case 'message_delta':
          if (ev.usage?.output_tokens != null) yield { type: 'usage', outputTokens: ev.usage.output_tokens };
          break;
        case 'error':
          throw new Error(ev.error?.message ?? 'Anthropic stream error');
      }
    }
  }

  async testConnection(cfg: ResolvedProviderConfig) {
    const res = await fetch(joinUrl(cfg.baseUrl, 'v1/models'), { headers: this.headers(cfg), signal: AbortSignal.timeout(10_000) });
    await ensureOk(res, 'Anthropic');
    const j: any = await res.json();
    const models = (j.data ?? []).map((m: any) => m.id);
    return { ok: true, detail: `Terhubung. ${models.length} model ditemukan.`, models };
  }
}
