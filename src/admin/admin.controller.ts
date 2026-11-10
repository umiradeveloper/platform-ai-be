import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, ConflictException } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma, ProviderType } from '@prisma/client';
import * as argon2 from 'argon2';
import type { Request } from 'express';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { encryptSecret, decryptSecret, maskSecret } from '../common/crypto.util';
import { PrismaService } from '../common/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { HermesAdapter } from '../providers/hermes.adapter';
import { SettingsService } from '../settings/settings.service';
import { rangeFrom, UsageService } from '../usage/usage.service';
import { clampDays } from '../usage/usage.controller';
import { CreateModelDto, CreateUserDto, UpdateModelDto, UpdateProviderDto, UpdateSettingsDto, UpdateUserDto } from './admin.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly providers: ProviderRegistry,
    private readonly settings: SettingsService,
  ) {}

  // ------------------------------------------------------------ Overview / KPI
  @ApiQuery({ name: 'days', required: false })
  @Get('dashboard')
  async dashboard(@Query('days') days?: string) {
    const d = clampDays(days);
    const from = rangeFrom(d);
    const [users, activeUsers, conversations, messages, totals, daily, byModel, dau, mau, latency, errorCount] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.conversation.count({ where: { deletedAt: null } }),
      this.prisma.message.count({ where: { role: 'ASSISTANT' } }),
      this.usage.totals(d),
      this.usage.daily(d),
      this.usage.byModel(d),
      this.distinctUsers(rangeFrom(1)),
      this.distinctUsers(rangeFrom(30)),
      this.prisma.usageLog.aggregate({ where: { createdAt: { gte: from }, status: 'SUCCESS' }, _avg: { latencyMs: true } }),
      this.prisma.usageLog.count({ where: { createdAt: { gte: from }, status: 'ERROR' } }),
    ]);
    const topUsers = await this.prisma.usageLog.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: from } },
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _count: { _all: true },
      orderBy: { _sum: { estimatedCost: 'desc' } },
      take: 10,
    });
    const userInfo = await this.prisma.user.findMany({ where: { id: { in: topUsers.map((t) => t.userId) } }, select: { id: true, name: true, email: true } });
    return {
      days: d,
      kpi: {
        users, activeUsers, conversations, messages, dau, mau,
        requests: totals.requests,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cost: totals.cost,
        avgLatencyMs: Math.round(latency._avg.latencyMs ?? 0),
        errorRate: totals.requests ? errorCount / totals.requests : 0,
      },
      daily,
      byModel,
      topUsers: topUsers.map((t) => ({
        ...userInfo.find((u) => u.id === t.userId),
        requests: t._count._all,
        tokens: (t._sum.inputTokens ?? 0) + (t._sum.outputTokens ?? 0),
        cost: Number(t._sum.estimatedCost ?? 0),
      })),
    };
  }

  private async distinctUsers(from: Date) {
    const r = await this.prisma.usageLog.groupBy({ by: ['userId'], where: { createdAt: { gte: from } } });
    return r.length;
  }

  // ------------------------------------------------------------ Users
  @ApiQuery({ name: 'q', required: false })
  @Get('users')
  async users(@Query('q') q?: string) {
    const users = await this.prisma.user.findMany({
      where: q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {},
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true, name: true, email: true, role: true, isActive: true, dailyTokenLimit: true, lastLoginAt: true, createdAt: true,
        authSource: true, externalRole: true, externalUsername: true,
        _count: { select: { conversations: true } },
      },
    });
    const since = rangeFrom(30);
    const usage = await this.prisma.usageLog.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since }, userId: { in: users.map((u) => u.id) } },
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
    });
    return users.map((u) => {
      const x = usage.find((g) => g.userId === u.id);
      return {
        ...u,
        conversations: u._count.conversations,
        _count: undefined,
        tokens30d: (x?._sum.inputTokens ?? 0) + (x?._sum.outputTokens ?? 0),
        cost30d: Number(x?._sum.estimatedCost ?? 0),
      };
    });
  }

  @Post('users')
  async createUser(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto, @Req() req: Request) {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Email sudah terdaftar');
    const user = await this.prisma.user.create({
      data: { name: dto.name.trim(), email, role: dto.role ?? 'USER', passwordHash: await argon2.hash(dto.password, { type: argon2.argon2id }) },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    });
    await this.audit.log({ actorId: actor.id, action: 'user.create', targetType: 'user', targetId: user.id, metadata: { email, role: user.role }, ipAddress: req.ip });
    return user;
  }

  @Patch('users/:id')
  async updateUser(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: Request) {
    if (id === actor.id && (dto.isActive === false || dto.role === 'USER')) {
      throw new BadRequestException('Anda tidak dapat menonaktifkan atau menurunkan role akun sendiri');
    }
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Pengguna tidak ditemukan');
    if (before.authSource === 'SUPERAPPS' && dto.role && dto.role !== before.role) {
      throw new BadRequestException('Role akun SuperApps mengikuti role di SuperApps (diatur lewat SUPERAPPS_ADMIN_ROLE_CODES).');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: { name: dto.name, role: dto.role, isActive: dto.isActive, dailyTokenLimit: dto.dailyTokenLimit },
      select: { id: true, name: true, email: true, role: true, isActive: true, dailyTokenLimit: true },
    });
    if (dto.isActive === false) {
      // AUTH-06: cabut semua sesi agar langsung logout
      await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.log({
      actorId: actor.id,
      action: dto.isActive === false ? 'user.deactivate' : dto.isActive === true && !before.isActive ? 'user.activate' : 'user.update',
      targetType: 'user', targetId: id, metadata: { ...dto }, ipAddress: req.ip,
    });
    return user;
  }

  // ------------------------------------------------------------ Models
  @Get('models')
  models() {
    return this.prisma.aIModel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { fallbackModel: { select: { id: true, displayName: true } }, _count: { select: { messages: true } } },
    });
  }

  @Post('models')
  async createModel(@CurrentUser() actor: AuthUser, @Body() dto: CreateModelDto, @Req() req: Request) {
    const exists = await this.prisma.aIModel.findUnique({ where: { provider_modelName: { provider: dto.provider, modelName: dto.modelName } } });
    if (exists) throw new ConflictException('Model dengan provider & nama tersebut sudah ada');
    const model = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.aIModel.updateMany({ data: { isDefault: false } });
      const provider = await tx.providerConfig.findUnique({ where: { type: dto.provider } });
      return tx.aIModel.create({ data: { ...this.modelData(dto), provider: dto.provider, modelName: dto.modelName, displayName: dto.displayName, providerConfigId: provider?.id } });
    });
    await this.audit.log({ actorId: actor.id, action: 'model.create', targetType: 'model', targetId: model.id, metadata: { provider: dto.provider, modelName: dto.modelName }, ipAddress: req.ip });
    return model;
  }

  @Patch('models/:id')
  async updateModel(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateModelDto, @Req() req: Request) {
    if (dto.fallbackModelId === id) throw new BadRequestException('Fallback tidak boleh model yang sama');
    const model = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.aIModel.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      return tx.aIModel.update({ where: { id }, data: { ...this.modelData(dto), modelName: dto.modelName, displayName: dto.displayName } });
    });
    await this.audit.log({ actorId: actor.id, action: 'model.update', targetType: 'model', targetId: id, metadata: { ...dto }, ipAddress: req.ip });
    return model;
  }

  @Delete('models/:id')
  @HttpCode(200)
  async deleteModel(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Req() req: Request) {
    const used = await this.prisma.usageLog.count({ where: { modelId: id } });
    if (used > 0) {
      // Model yang sudah punya riwayat penggunaan dinonaktifkan saja agar laporan biaya tetap utuh.
      await this.prisma.aIModel.update({ where: { id }, data: { isActive: false, isDefault: false } });
      await this.audit.log({ actorId: actor.id, action: 'model.deactivate', targetType: 'model', targetId: id, ipAddress: req.ip });
      return { ok: true, deactivated: true, message: 'Model sudah memiliki riwayat penggunaan sehingga dinonaktifkan (bukan dihapus).' };
    }
    await this.prisma.aIModel.delete({ where: { id } });
    await this.audit.log({ actorId: actor.id, action: 'model.delete', targetType: 'model', targetId: id, ipAddress: req.ip });
    return { ok: true, deactivated: false };
  }

  private modelData(dto: UpdateModelDto) {
    return {
      description: dto.description,
      isActive: dto.isActive,
      isDefault: dto.isDefault,
      maxContextTokens: dto.maxContextTokens,
      maxOutputTokens: dto.maxOutputTokens,
      inputPricePer1M: dto.inputPricePer1M != null ? new Prisma.Decimal(dto.inputPricePer1M) : undefined,
      outputPricePer1M: dto.outputPricePer1M != null ? new Prisma.Decimal(dto.outputPricePer1M) : undefined,
      fallbackModelId: dto.fallbackModelId,
      sortOrder: dto.sortOrder,
    };
  }

  // ------------------------------------------------------------ Providers (API Configuration)
  @Get('providers')
  async providersList() {
    const rows = await this.prisma.providerConfig.findMany();
    return Promise.all(
      (Object.keys(ProviderRegistry.defaults) as ProviderType[]).map(async (type) => {
        const d = ProviderRegistry.defaults[type];
        const row = rows.find((r) => r.type === type);
        const resolved = await this.providers.resolve(type);
        let dbKey: string | null = null;
        if (row?.apiKeyEncrypted) {
          try {
            dbKey = decryptSecret(row.apiKeyEncrypted);
          } catch {
            dbKey = null;
          }
        }
        return {
          type,
          displayName: row?.displayName ?? d.label,
          baseUrl: resolved.baseUrl,
          baseUrlSource: row?.baseUrl ? 'database' : process.env[d.urlEnv] ? 'env' : 'default',
          apiKeyMasked: maskSecret(resolved.apiKey), // API key TIDAK pernah dikirim utuh ke frontend
          apiKeySource: dbKey ? 'database' : process.env[d.keyEnv] ? 'env' : 'none',
          extraHeaders: Object.fromEntries(Object.keys(resolved.extraHeaders).map((k) => [k, '••••'])),
          isEnabled: resolved.isEnabled,
          envKeys: { apiKey: d.keyEnv, baseUrl: d.urlEnv },
        };
      }),
    );
  }

  @Patch('providers/:type')
  async updateProvider(@CurrentUser() actor: AuthUser, @Param('type') type: ProviderType, @Body() dto: UpdateProviderDto, @Req() req: Request) {
    if (!(type in ProviderRegistry.defaults)) throw new BadRequestException('Provider tidak dikenal');
    const data: Prisma.ProviderConfigUncheckedUpdateInput = {
      displayName: dto.displayName,
      baseUrl: dto.baseUrl === '' ? null : dto.baseUrl,
      isEnabled: dto.isEnabled,
      extraHeaders: dto.extraHeaders as Prisma.InputJsonValue | undefined,
    };
    if (dto.apiKey !== undefined) data.apiKeyEncrypted = dto.apiKey === '' ? null : encryptSecret(dto.apiKey.trim());
    const row = await this.prisma.providerConfig.upsert({
      where: { type },
      create: {
        type,
        displayName: dto.displayName ?? ProviderRegistry.defaults[type].label,
        baseUrl: dto.baseUrl || null,
        isEnabled: dto.isEnabled ?? true,
        extraHeaders: dto.extraHeaders as Prisma.InputJsonValue | undefined,
        apiKeyEncrypted: dto.apiKey ? encryptSecret(dto.apiKey.trim()) : null,
      },
      update: data,
    });
    await this.prisma.aIModel.updateMany({ where: { provider: type, providerConfigId: null }, data: { providerConfigId: row.id } });
    await this.audit.log({
      actorId: actor.id, action: 'provider.update', targetType: 'provider', targetId: type,
      metadata: { baseUrl: dto.baseUrl, isEnabled: dto.isEnabled, apiKeyChanged: dto.apiKey !== undefined, extraHeaders: dto.extraHeaders ? Object.keys(dto.extraHeaders) : undefined },
      ipAddress: req.ip,
    });
    return { ok: true };
  }

  @HttpCode(200)
  @Post('providers/:type/test')
  async testProvider(@Param('type') type: ProviderType) {
    if (!(type in ProviderRegistry.defaults)) throw new BadRequestException('Provider tidak dikenal');
    const cfg = await this.providers.resolve(type);
    try {
      return await this.providers.adapter(type).testConnection(cfg);
    } catch (e) {
      return { ok: false, detail: type === 'HERMES' ? HermesAdapter.explain(e) : String(e?.message ?? e) };
    }
  }

  // ------------------------------------------------------------ Usage & Costs
  @ApiQuery({ name: 'days', required: false })
  @Get('usage')
  async usageReport(@Query('days') days?: string) {
    const d = clampDays(days);
    const [daily, byModel, totals] = await Promise.all([this.usage.daily(d), this.usage.byModel(d), this.usage.totals(d)]);
    const recent = await this.prisma.usageLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { name: true, email: true } }, model: { select: { displayName: true, provider: true } } },
    });
    return { days: d, totals, daily, byModel, recent };
  }

  @ApiQuery({ name: 'days', required: false })
  @Get('costs')
  async costs(@Query('days') days?: string) {
    const d = clampDays(days);
    const [daily, byModel, totals] = await Promise.all([this.usage.daily(d), this.usage.byModel(d), this.usage.totals(d)]);
    const usdToIdr = Number(process.env.USD_TO_IDR ?? 16000);
    const elapsed = daily.length;
    const projectedMonth = elapsed ? (totals.cost / elapsed) * 30 : 0;
    return { days: d, usdToIdr, totals, projectedMonthUsd: projectedMonth, daily: daily.map((x) => ({ day: x.day, cost: x.cost })), byModel };
  }

  // ------------------------------------------------------------ Activity logs
  @ApiQuery({ name: 'take', required: false })
  @Get('audit-logs')
  auditLogs(@Query('take') take?: string) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(take) || 200, 1000),
      include: { actor: { select: { name: true, email: true } } },
    });
  }

  // ------------------------------------------------------------ System settings
  @Get('settings')
  getSettings() {
    return this.settings.get();
  }

  @Patch('settings')
  async updateSettings(@CurrentUser() actor: AuthUser, @Body() dto: UpdateSettingsDto, @Req() req: Request) {
    const s = await this.settings.update(dto);
    await this.audit.log({ actorId: actor.id, action: 'settings.update', metadata: { keys: Object.keys(dto) }, ipAddress: req.ip });
    return s;
  }
}
