import { ProviderType } from '@prisma/client';

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ResolvedProviderConfig {
  type: ProviderType;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: Record<string, string>;
}

export interface StreamRequest {
  model: string;
  messages: ChatMessageInput[]; // termasuk system prompt di index 0 (jika ada)
  maxOutputTokens: number;
  signal: AbortSignal;
  /** id percakapan Umira — dipakai adapter yang mendukung sesi (mis. Hermes) */
  conversationId?: string;
  userId?: string;
}

/** Event yang dialirkan adapter ke Chat Service (provider-agnostic). */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id?: string; tool: string; label?: string; emoji?: string; status?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number };

export interface ProviderAdapter {
  readonly type: ProviderType;
  stream(req: StreamRequest, cfg: ResolvedProviderConfig): AsyncGenerator<StreamEvent>;
  /** Cek koneksi & kredensial — dipakai tombol "Test koneksi" di dashboard admin. */
  testConnection(cfg: ResolvedProviderConfig): Promise<{ ok: boolean; detail: string; models?: string[] }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
  }
}
