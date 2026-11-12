import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AIModel, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { ExtractedFile, SynologyService } from '../synology/synology.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { AuthUser } from '../common/auth.decorators';
import { SettingsService } from '../settings/settings.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ChatMessageInput, ProviderError } from '../providers/provider.types';
import { HermesAdapter } from '../providers/hermes.adapter';
import { aiLatency, aiRequests, aiTokens } from '../common/metrics';

/** Callback event ke klien (SSE) — provider-agnostic. */
export type Emit = (event: string, data: unknown) => void;

export interface GenerateResult {
  conversationId: string;
  assistantMessageId: string | null;
  content: string;
  model: { id: string; displayName: string; provider: string };
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  status: 'SUCCESS' | 'CANCELLED' | 'ERROR';
  error?: string;
}

const STOP_CHANNEL = 'umira:chat:stop';
const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatService.name);
  /** Generasi aktif di instance ini: conversationId → AbortController (CHAT-05). */
  private readonly active = new Map<string, AbortController>();
  private sub?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly providers: ProviderRegistry,
    private readonly redis: RedisService,
    private readonly synology: SynologyService,
    private readonly knowledge: KnowledgeService,
  ) {}

  onModuleInit() {
    // Stop lintas-instance: perintah stop dipublish ke Redis, instance yang memegang stream yang meng-abort.
    // Tanpa Redis (1 instance) sub tidak diperlukan — stop langsung lewat Map `active`.
    const sub = this.redis.duplicate();
    if (!sub) return;
    this.sub = sub;
    this.sub.on('error', (e) => this.logger.warn(`Redis sub error: ${e.message}`));
    this.sub.subscribe(STOP_CHANNEL).catch(() => undefined);
    this.sub.on('message', (_ch, convId) => this.active.get(convId)?.abort('user_stop'));
  }

  async onModuleDestroy() {
    for (const c of this.active.values()) c.abort('shutdown');
    await this.sub?.quit().catch(() => undefined);
  }

  async requestStop(user: AuthUser, conversationId: string) {
    await this.ownConversation(user.id, conversationId);
    const local = this.active.get(conversationId);
    if (local) local.abort('user_stop');
    else if (this.redis.client) await this.redis.client.publish(STOP_CHANNEL, conversationId).catch(() => undefined);
    return { ok: true, stopped: !!local };
  }

  isGenerating(conversationId: string) {
    return this.active.has(conversationId);
  }

  // ---------------------------------------------------------------- persiapan

  async ownConversation(userId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!conv) throw new NotFoundException('Percakapan tidak ditemukan');
    return conv;
  }

  private async pickModel(requestedId?: string | null, fallbackId?: string | null): Promise<AIModel> {
    for (const id of [requestedId, fallbackId]) {
      if (!id) continue;
      const m = await this.prisma.aIModel.findFirst({ where: { id, isActive: true } });
      if (m) return m;
      if (id === requestedId) throw new BadRequestException('Model tidak tersedia atau sedang dinonaktifkan');
    }
    const def =
      (await this.prisma.aIModel.findFirst({ where: { isActive: true, isDefault: true } })) ??
      (await this.prisma.aIModel.findFirst({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }));
    if (!def) throw new BadRequestException('Belum ada model AI aktif. Admin perlu menambahkan model.');
    return def;
  }

  /** Batas token harian per pengguna (Security: "Batas token dan penggunaan per pengguna"). */
  private async assertQuota(userId: string) {
    const [user, s] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { dailyTokenLimit: true } }),
      this.settings.get(),
    ]);
    const limit = user.dailyTokenLimit ?? s.defaultDailyTokenLimit;
    if (!limit) return;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const agg = await this.prisma.usageLog.aggregate({
      where: { userId, createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const used = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
    if (used >= limit) {
      throw new ForbiddenException(`Batas token harian tercapai (${used.toLocaleString('id-ID')} / ${limit.toLocaleString('id-ID')}). Coba lagi besok atau hubungi admin.`);
    }
  }

  /** Context management (CHAT-12): system prompt + pesan terbaru yang muat dalam anggaran token model. */
  private async buildContext(conversationId: string, model: AIModel): Promise<ChatMessageInput[]> {
    const s = await this.settings.get();
    const history = await this.prisma.message.findMany({
      where: { conversationId, isError: false },
      orderBy: { createdAt: 'desc' },
      take: s.maxHistoryMessages,
      select: { role: true, content: true, attachments: { select: { source: true, name: true, path: true, text: true, truncated: true } } },
    });
    const budget = Math.max(2000, model.maxContextTokens - model.maxOutputTokens - estimateTokens(s.systemPrompt) - 500);
    const picked: ChatMessageInput[] = [];
    let used = 0;
    for (const m of history) {
      const content = withAttachments(m.content, m.attachments);
      const t = estimateTokens(content);
      if (picked.length > 0 && used + t > budget) break;
      used += t;
      picked.unshift({ role: m.role === 'ASSISTANT' ? 'assistant' : m.role === 'SYSTEM' ? 'system' : 'user', content });
    }
    const system = `${s.systemPrompt}\n\nTanggal hari ini: ${new Date().toLocaleDateString('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' })}.`;
    return [{ role: 'system', content: system }, ...picked];
  }

  // ---------------------------------------------------------------- entry points

  /** CHAT-01..04: kirim pesan baru (membuat percakapan bila belum ada). */
  async send(
    user: AuthUser,
    input: {
      conversationId?: string;
      content: string;
      modelId?: string;
      synologyFiles?: string[];
      synologyFolders?: string[];
      useKnowledge?: boolean;
      knowledgeIndexIds?: string[];
    },
    emit: Emit,
    signal?: AbortSignal,
  ) {
    const s = await this.settings.get();
    const content = input.content.trim();
    if (!content) throw new BadRequestException('Pesan tidak boleh kosong');
    if (content.length > s.maxMessageChars) throw new BadRequestException(`Pesan terlalu panjang (maks. ${s.maxMessageChars} karakter)`);
    await this.assertQuota(user.id);

    let conv = input.conversationId ? await this.ownConversation(user.id, input.conversationId) : null;
    if (conv && this.active.has(conv.id)) throw new BadRequestException('AI masih menjawab di percakapan ini. Hentikan dulu atau tunggu selesai.');
    const model = await this.pickModel(input.modelId, conv?.modelId);

    // Lampiran dari Synology: diunduh & diekstrak dengan hak akses user — gagal di sini = HTTP error biasa.
    const files: (ExtractedFile & { source: string })[] = [];
    for (const p of [...new Set(input.synologyFiles ?? [])]) files.push({ source: 'synology', ...(await this.synology.extract(user.id, p)) });
    for (const p of [...new Set(input.synologyFolders ?? [])]) {
      for (const f of await this.synology.extractFolder(user.id, p)) files.push({ source: f.mimeType === 'text/x-folder-listing' ? 'folder' : 'synology', ...f });
    }
    // RAG: potongan relevan dari folder basis pengetahuan pengguna
    if (input.useKnowledge && this.knowledge.enabled) {
      for (const f of await this.knowledge.retrieveForChat(user.id, content, input.knowledgeIndexIds)) files.push({ source: 'knowledge', ...f });
    }

    if (!conv) conv = await this.prisma.conversation.create({ data: { userId: user.id, modelId: model.id } });
    const userMsg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        role: 'USER',
        content,
        inputTokens: estimateTokens(withAttachments(content, files)),
        attachments: files.length
          ? { create: files.map((f) => ({ source: f.source, path: f.path, name: f.name, mimeType: f.mimeType, size: f.size, text: f.text, truncated: f.truncated })) }
          : undefined,
      },
    });
    emit('meta', {
      conversationId: conv.id,
      userMessageId: userMsg.id,
      model: this.modelInfo(model),
      attachments: files.map((f) => ({ source: f.source, name: f.name, path: f.path, size: f.size, truncated: f.truncated })),
      knowledgeUsed: !!input.useKnowledge,
    });

    if (conv.title === 'New Chat' && s.autoTitle) {
      const title = makeTitle(content);
      await this.prisma.conversation.update({ where: { id: conv.id }, data: { title } });
      emit('title', { conversationId: conv.id, title });
    }
    return this.generate(user, conv.id, model, emit, signal);
  }

  /** CHAT-06: hapus jawaban AI terakhir lalu generate ulang dari pesan pengguna terakhir. */
  async regenerate(user: AuthUser, conversationId: string, modelId: string | undefined, emit: Emit, signal?: AbortSignal) {
    const conv = await this.ownConversation(user.id, conversationId);
    if (this.active.has(conv.id)) throw new BadRequestException('AI masih menjawab di percakapan ini.');
    await this.assertQuota(user.id);
    const lastUser = await this.prisma.message.findFirst({
      where: { conversationId, role: 'USER' },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastUser) throw new BadRequestException('Tidak ada pesan untuk di-generate ulang');
    await this.prisma.message.deleteMany({ where: { conversationId, role: 'ASSISTANT', createdAt: { gte: lastUser.createdAt } } });
    const model = await this.pickModel(modelId, conv.modelId);
    emit('meta', { conversationId, userMessageId: lastUser.id, model: this.modelInfo(model), regenerate: true });
    return this.generate(user, conversationId, model, emit, signal);
  }

  // ---------------------------------------------------------------- inti generasi

  private async generate(user: AuthUser, conversationId: string, primary: AIModel, emit: Emit, clientSignal?: AbortSignal): Promise<GenerateResult> {
    const controller = new AbortController();
    this.active.set(conversationId, controller);
    const onClientAbort = () => controller.abort('client_disconnect');
    clientSignal?.addEventListener('abort', onClientAbort);
    const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS ?? 300_000);
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

    const chain: AIModel[] = [primary];
    if (primary.fallbackModelId) {
      const fb = await this.prisma.aIModel.findFirst({ where: { id: primary.fallbackModelId, isActive: true } });
      if (fb && fb.id !== primary.id) chain.push(fb);
    }

    let lastError: unknown;
    try {
      for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        const started = Date.now();
        let text = '';
        let inTok: number | undefined;
        let outTok: number | undefined;
        const tools: { id?: string; tool: string; label?: string; emoji?: string; status?: string; at: string }[] = [];
        const context = await this.buildContext(conversationId, model);

        try {
          const cfg = await this.providers.resolve(model.provider);
          if (!cfg.isEnabled) throw new ProviderError(`Provider ${model.provider} sedang dinonaktifkan admin`, 503, true);
          const adapter = this.providers.adapter(model.provider);

          for await (const ev of adapter.stream(
            { model: model.modelName, messages: context, maxOutputTokens: model.maxOutputTokens, signal: controller.signal, conversationId, userId: user.id },
            cfg,
          )) {
            if (ev.type === 'delta') {
              text += ev.text;
              emit('delta', { text: ev.text });
            } else if (ev.type === 'tool') {
              // Gabungkan update status (running → completed) untuk tool call yang sama.
              const existing = ev.id ? tools.find((t) => t.id === ev.id) : undefined;
              if (existing) {
                existing.status = ev.status ?? existing.status;
                if (ev.label) existing.label = ev.label;
                emit('tool', existing);
              } else {
                const t = { id: ev.id, tool: ev.tool, label: ev.label, emoji: ev.emoji, status: ev.status, at: new Date().toISOString() };
                if (tools.length < 100) tools.push(t);
                emit('tool', t);
              }
            } else if (ev.type === 'usage') {
              if (ev.inputTokens != null) inTok = ev.inputTokens;
              if (ev.outputTokens != null) outTok = ev.outputTokens;
            }
          }
          if (looksLikeRawToolCall(text)) {
            // Model di balik agent menulis pemanggilan tool sebagai teks (tool tidak benar-benar dijalankan).
            // Tandai sebagai error agar tidak ikut menjadi konteks percakapan berikutnya.
            return await this.finish(user, conversationId, model, text, tools, inTok, outTok, context, started, 'SUCCESS', emit, undefined, RAW_TOOL_MSG);
          }
          return await this.finish(user, conversationId, model, text, tools, inTok, outTok, context, started, 'SUCCESS', emit);
        } catch (err) {
          if (controller.signal.aborted) {
            const reason = String(controller.signal.reason ?? 'aborted');
            const r = await this.finish(user, conversationId, model, text, tools, inTok, outTok, context, started, 'CANCELLED', emit, reason);
            if (reason === 'timeout') emit('error', { message: 'Waktu respons AI habis (timeout).' });
            return r;
          }
          lastError = err;
          const message = model.provider === 'HERMES' ? HermesAdapter.explain(err) : String(err?.message ?? err);
          this.logger.warn(`Provider ${model.provider}/${model.modelName} gagal: ${message}`);
          await this.logUsage(user.id, model, conversationId, estimateTokens(context.map((c) => c.content).join('')), estimateTokens(text), Date.now() - started, 'ERROR', message);
          aiRequests.inc({ provider: model.provider, model: model.modelName, status: 'error' });

          const canFallback = i < chain.length - 1 && text.length === 0 && !(err instanceof ProviderError && !err.retryable && err.status === 400);
          if (canFallback) {
            emit('fallback', { from: this.modelInfo(model), to: this.modelInfo(chain[i + 1]), reason: message });
            continue;
          }
          if (text.length) {
            // Sebagian jawaban sudah terkirim — simpan agar tidak hilang, tandai terpotong.
            await this.saveAssistant(conversationId, model, text + '\n\n_[Respons terputus karena kesalahan provider]_', tools, 0, estimateTokens(text), false);
          }
          emit('error', { message: friendly(message) });
          return {
            conversationId, assistantMessageId: null, content: text, model: this.modelInfo(model),
            inputTokens: 0, outputTokens: 0, estimatedCost: 0, status: 'ERROR', error: friendly(message),
          };
        }
      }
      throw lastError ?? new Error('Generasi gagal');
    } finally {
      clearTimeout(timer);
      clientSignal?.removeEventListener('abort', onClientAbort);
      if (this.active.get(conversationId) === controller) this.active.delete(conversationId);
    }
  }

  private async finish(
    user: AuthUser,
    conversationId: string,
    model: AIModel,
    text: string,
    tools: unknown[],
    inTok: number | undefined,
    outTok: number | undefined,
    context: ChatMessageInput[],
    started: number,
    status: 'SUCCESS' | 'CANCELLED',
    emit: Emit,
    reason?: string,
    softError?: string,
  ): Promise<GenerateResult> {
    const inputTokens = inTok ?? estimateTokens(context.map((c) => c.content).join('\n'));
    const outputTokens = outTok ?? estimateTokens(text);
    const latency = Date.now() - started;
    let assistantMessageId: string | null = null;

    if (text.length || status === 'SUCCESS') {
      const content = text || '_(AI tidak mengembalikan jawaban)_';
      assistantMessageId = await this.saveAssistant(conversationId, model, content, tools, inputTokens, outputTokens, !!softError);
    }
    if (softError) emit('error', { message: softError });
    const cost = await this.logUsage(user.id, model, conversationId, inputTokens, outputTokens, latency, status, reason);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { modelId: model.id, updatedAt: new Date() } });

    aiRequests.inc({ provider: model.provider, model: model.modelName, status: status.toLowerCase() });
    aiTokens.inc({ provider: model.provider, model: model.modelName, direction: 'input' }, inputTokens);
    aiTokens.inc({ provider: model.provider, model: model.modelName, direction: 'output' }, outputTokens);
    aiLatency.observe({ provider: model.provider, model: model.modelName }, latency / 1000);

    const result: GenerateResult = {
      conversationId, assistantMessageId, content: text, model: this.modelInfo(model),
      inputTokens, outputTokens, estimatedCost: cost, status,
    };
    emit('done', { ...result, content: undefined, latencyMs: latency });
    return result;
  }

  private async saveAssistant(conversationId: string, model: AIModel, content: string, tools: unknown[], inputTokens: number, outputTokens: number, isError: boolean) {
    const m = await this.prisma.message.create({
      data: {
        conversationId, modelId: model.id, role: 'ASSISTANT', content, inputTokens, outputTokens, isError,
        toolEvents: tools.length ? (tools as Prisma.InputJsonValue) : undefined,
      },
    });
    return m.id;
  }

  private async logUsage(userId: string, model: AIModel, conversationId: string, inputTokens: number, outputTokens: number, latencyMs: number, status: 'SUCCESS' | 'CANCELLED' | 'ERROR', errorMessage?: string) {
    const cost = (inputTokens * Number(model.inputPricePer1M) + outputTokens * Number(model.outputPricePer1M)) / 1_000_000;
    await this.prisma.usageLog.create({
      data: {
        userId, modelId: model.id, conversationId, inputTokens, outputTokens, latencyMs, status,
        estimatedCost: new Prisma.Decimal(cost.toFixed(6)),
        errorMessage: errorMessage?.slice(0, 1000),
      },
    });
    return cost;
  }

  private modelInfo(m: AIModel) {
    return { id: m.id, displayName: m.displayName, provider: m.provider };
  }
}

const RAW_TOOL_MSG =
  'Agent mengembalikan perintah tool mentah, bukan jawaban (tool tidak dijalankan). Biasanya karena model di Hermes ' +
  'tidak mendukung tool calling dengan baik. Klik "Generate ulang", atau minta admin memakai model dengan tool calling yang andal di Hermes.';

/** Jawaban yang isinya hanya JSON pemanggilan tool, mis. {"name":"web_search","parameters":{...}}. */
export function looksLikeRawToolCall(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!t.startsWith('{') || !t.endsWith('}') || t.length > 4000) return false;
  try {
    const j = JSON.parse(t);
    return typeof j?.name === 'string' && (typeof j.parameters === 'object' || typeof j.arguments === 'object' || typeof j.arguments === 'string');
  } catch {
    return /^\{\s*"name"\s*:\s*"[\w.-]+"\s*,\s*"(parameters|arguments)"\s*:/.test(t);
  }
}

/** Gabungkan isi file lampiran ke pesan user agar terbaca model (format jelas, dengan batas file). */
function withAttachments(content: string, files: { source?: string; name: string; path: string; text: string; truncated: boolean }[]) {
  if (!files?.length) return content;
  const own = files.filter((f) => f.source !== 'knowledge');
  const kb = files.filter((f) => f.source === 'knowledge');
  const parts = [content];
  if (own.length) {
    const blocks = own.map((f) =>
      f.source === 'folder'
        ? `<daftar_folder path="${f.path}">\n${f.text}\n</daftar_folder>`
        : `<lampiran nama="${f.name}" sumber="Synology" path="${f.path}"${f.truncated ? ' terpotong="ya"' : ''}>\n${f.text}\n</lampiran>`,
    );
    const n = own.filter((f) => f.source !== 'folder').length;
    parts.push(`[Pengguna melampirkan ${n} file dari Synology${own.some((f) => f.source === 'folder') ? ' (termasuk isi folder)' : ''}. Gunakan isinya untuk menjawab.]\n${blocks.join('\n\n')}`);
  }
  if (kb.length) {
    const blocks = kb.map((f) => `<sumber nama="${f.name}" path="${f.path}">\n${f.text}\n</sumber>`);
    parts.push(
      `[Potongan paling relevan dari basis pengetahuan Synology pengguna. Jawab berdasarkan sumber ini bila relevan, ` +
        `sebutkan nama file sumbernya, dan katakan terus terang bila informasinya tidak ada di sumber.]\n${blocks.join('\n\n')}`,
    );
  }
  return parts.join('\n\n');
}

function makeTitle(content: string) {
  const clean = content.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Percakapan baru';
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

function friendly(msg: string) {
  if (/401|403|invalid.*key|api key/i.test(msg) && !/Hermes/.test(msg)) return 'Kredensial provider AI tidak valid. Hubungi administrator.';
  if (/429|rate/i.test(msg)) return 'Provider AI sedang membatasi permintaan (rate limit). Coba lagi sebentar.';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|timeout/i.test(msg) && !/Hermes/.test(msg)) return 'Provider AI tidak dapat dihubungi. Coba lagi nanti.';
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

