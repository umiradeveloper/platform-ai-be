/**
 * Seed awal: model AI default (termasuk Hermes Agent) + akun admin opsional.
 * Jalankan: npm run seed   (env: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME)
 * Harga dalam USD per 1 juta token — sesuaikan dengan tarif provider terbaru di dashboard admin.
 */
import { PrismaClient, Prisma, ProviderType } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const MODELS: {
  provider: ProviderType; modelName: string; displayName: string; description: string;
  maxContextTokens: number; maxOutputTokens: number; inputPricePer1M: number; outputPricePer1M: number;
  isDefault?: boolean; sortOrder: number;
}[] = [
  {
    provider: 'HERMES', modelName: process.env.HERMES_MODEL ?? 'hermes-agent', displayName: 'Hermes Agent (Umira)',
    description: 'Agent internal Umira — bisa memakai tools (web search, file, terminal) sesuai konfigurasi Hermes.',
    maxContextTokens: 128000, maxOutputTokens: 8192, inputPricePer1M: 0, outputPricePer1M: 0, isDefault: true, sortOrder: 0,
  },
  {
    provider: 'OPENAI', modelName: 'gpt-4o-mini', displayName: 'GPT-4o mini',
    description: 'Cepat & hemat untuk tugas harian.', maxContextTokens: 128000, maxOutputTokens: 4096,
    inputPricePer1M: 0.15, outputPricePer1M: 0.6, sortOrder: 10,
  },
  {
    provider: 'ANTHROPIC', modelName: 'claude-sonnet-4-5', displayName: 'Claude Sonnet',
    description: 'Kuat untuk penulisan, analisis, dan coding.', maxContextTokens: 200000, maxOutputTokens: 8192,
    inputPricePer1M: 3, outputPricePer1M: 15, sortOrder: 20,
  },
  {
    provider: 'GEMINI', modelName: 'gemini-2.5-flash', displayName: 'Gemini Flash',
    description: 'Model Google yang cepat dengan konteks panjang.', maxContextTokens: 1000000, maxOutputTokens: 8192,
    inputPricePer1M: 0.3, outputPricePer1M: 2.5, sortOrder: 30,
  },
];

async function main() {
  for (const m of MODELS) {
    await prisma.aIModel.upsert({
      where: { provider_modelName: { provider: m.provider, modelName: m.modelName } },
      update: {},
      create: {
        ...m,
        inputPricePer1M: new Prisma.Decimal(m.inputPricePer1M),
        outputPricePer1M: new Prisma.Decimal(m.outputPricePer1M),
        // Model tanpa API key di env dibuat nonaktif dulu; aktifkan dari dashboard setelah key diisi.
        isActive: m.provider === 'HERMES' || !!process.env[`${m.provider}_API_KEY`],
      },
    });
  }

  // Fallback: Hermes → GPT-4o mini (jika aktif) saat Hermes tidak dapat dihubungi.
  const hermes = await prisma.aIModel.findFirst({ where: { provider: 'HERMES' } });
  const fb = await prisma.aIModel.findFirst({ where: { provider: 'OPENAI', modelName: 'gpt-4o-mini' } });
  if (hermes && fb && !hermes.fallbackModelId) await prisma.aIModel.update({ where: { id: hermes.id }, data: { fallbackModelId: fb.id } });

  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    await prisma.user.upsert({
      where: { email },
      update: { role: 'ADMIN', isActive: true },
      create: { email, name: process.env.SEED_ADMIN_NAME ?? 'Administrator', role: 'ADMIN', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
    });
    console.log(`Admin siap: ${email}`);
  } else {
    console.log('SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD tidak di-set — pengguna pertama yang registrasi otomatis menjadi ADMIN.');
  }
  console.log(`Seed selesai: ${MODELS.length} model.`);
}

main().finally(() => prisma.$disconnect());
