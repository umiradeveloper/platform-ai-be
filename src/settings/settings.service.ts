import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

/** Pengaturan aplikasi yang bisa diubah admin dari dashboard (System Settings). */
export interface AppSettings {
  appName: string;
  systemPrompt: string;
  allowRegistration: boolean;
  defaultDailyTokenLimit: number; // 0 = tanpa batas
  maxMessageChars: number;
  maxHistoryMessages: number;
  autoTitle: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  appName: 'Umira AI',
  systemPrompt:
    'Kamu adalah Umira AI, asisten AI internal PT Umira (Construction · Development · Investment). ' +
    'Jawab dengan jelas, ringkas, dan akurat dalam bahasa yang dipakai pengguna. Gunakan Markdown bila membantu.',
  allowRegistration: true,
  defaultDailyTokenLimit: 200000,
  maxMessageChars: 32000,
  maxHistoryMessages: 40,
  autoTitle: true,
};

@Injectable()
export class SettingsService {
  private cache: { value: AppSettings; at: number } | null = null;
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AppSettings> {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.value;
    const rows = await this.prisma.systemSetting.findMany();
    const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
    this.cache = { value: merged as unknown as AppSettings, at: Date.now() };
    return this.cache.value;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const entries = Object.entries(patch).filter(([k, v]) => k in DEFAULT_SETTINGS && v !== undefined);
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.systemSetting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue },
          update: { value: value as Prisma.InputJsonValue },
        }),
      ),
    );
    this.cache = null;
    return this.get();
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
