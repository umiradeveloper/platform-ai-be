import { BadRequestException, Global, Injectable, Module } from '@nestjs/common';
import { ProviderType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { decryptSecret } from '../common/crypto.util';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { HermesAdapter } from './hermes.adapter';
import { OpenAICompatibleAdapter } from './openai-compatible.adapter';
import { ProviderAdapter, ResolvedProviderConfig } from './provider.types';

/** Default bila provider belum dikonfigurasi lewat dashboard admin. */
const ENV_DEFAULTS: Record<ProviderType, { baseUrl: string; keyEnv: string; urlEnv: string; label: string }> = {
  OPENAI: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', urlEnv: 'OPENAI_BASE_URL', label: 'OpenAI' },
  ANTHROPIC: { baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', urlEnv: 'ANTHROPIC_BASE_URL', label: 'Anthropic' },
  GEMINI: { baseUrl: 'https://generativelanguage.googleapis.com', keyEnv: 'GEMINI_API_KEY', urlEnv: 'GEMINI_BASE_URL', label: 'Google Gemini' },
  HERMES: { baseUrl: 'http://localhost:8642/v1', keyEnv: 'HERMES_API_KEY', urlEnv: 'HERMES_BASE_URL', label: 'Hermes Agent' },
  OPENAI_COMPATIBLE: { baseUrl: 'http://localhost:11434/v1', keyEnv: 'OPENAI_COMPATIBLE_API_KEY', urlEnv: 'OPENAI_COMPATIBLE_BASE_URL', label: 'OpenAI-compatible' },
};

@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderType, ProviderAdapter>([
    ['OPENAI', new OpenAICompatibleAdapter('OPENAI')],
    ['OPENAI_COMPATIBLE', new OpenAICompatibleAdapter('OPENAI_COMPATIBLE')],
    ['ANTHROPIC', new AnthropicAdapter()],
    ['GEMINI', new GeminiAdapter()],
    ['HERMES', new HermesAdapter()],
  ]);

  constructor(private readonly prisma: PrismaService) {}

  static defaults = ENV_DEFAULTS;

  adapter(type: ProviderType): ProviderAdapter {
    const a = this.adapters.get(type);
    if (!a) throw new BadRequestException(`Provider ${type} belum didukung`);
    return a;
  }

  /** Konfigurasi dari DB (diatur admin) diprioritaskan; fallback ke environment variable. */
  async resolve(type: ProviderType): Promise<ResolvedProviderConfig & { isEnabled: boolean }> {
    const d = ENV_DEFAULTS[type];
    const row = await this.prisma.providerConfig.findUnique({ where: { type } });
    let apiKey: string | null = process.env[d.keyEnv] || null;
    if (row?.apiKeyEncrypted) apiKey = decryptSecret(row.apiKeyEncrypted);
    return {
      type,
      baseUrl: row?.baseUrl || process.env[d.urlEnv] || d.baseUrl,
      apiKey,
      extraHeaders: (row?.extraHeaders as Record<string, string>) ?? {},
      isEnabled: row ? row.isEnabled : true,
    };
  }
}

@Global()
@Module({ providers: [ProviderRegistry], exports: [ProviderRegistry] })
export class ProvidersModule {}
