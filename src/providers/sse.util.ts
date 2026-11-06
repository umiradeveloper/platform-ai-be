import { ProviderError } from './provider.types';

export interface SseRecord {
  event?: string;
  data: string;
}

/** Parser Server-Sent Events minimal untuk body fetch() (mendukung event:, data: multi-baris, komentar). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseRecord | null => {
    if (!data.length) {
      event = undefined;
      return null;
    }
    const rec = { event, data: data.join('\n') };
    event = undefined;
    data = [];
    return rec;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
        if (line === '') {
          const rec = flush();
          if (rec) yield rec;
          continue;
        }
        if (line.startsWith(':')) continue; // komentar / keepalive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
    }
    const rec = flush();
    if (rec) yield rec;
  } finally {
    reader.releaseLock();
  }
}

export async function ensureOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? j?.error ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
  throw new ProviderError(`${provider} error ${res.status}: ${String(detail).slice(0, 300)}`, res.status, retryable);
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
