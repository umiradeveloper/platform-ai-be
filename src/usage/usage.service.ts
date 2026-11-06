import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

export function rangeFrom(days: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Agregasi harian (token, biaya, request) — dipakai /usage/me dan /admin/usage. */
  async daily(days: number, userId?: string) {
    const from = rangeFrom(days);
    const rows = await this.prisma.$queryRaw<
      { day: Date | string; requests: bigint; inputTokens: Prisma.Decimal | null; outputTokens: Prisma.Decimal | null; cost: Prisma.Decimal | null; errors: Prisma.Decimal | null }[]
    >(Prisma.sql`
      SELECT DATE(createdAt) AS day,
             COUNT(*) AS requests,
             SUM(inputTokens) AS inputTokens,
             SUM(outputTokens) AS outputTokens,
             SUM(estimatedCost) AS cost,
             SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors
      FROM UsageLog
      WHERE createdAt >= ${from} ${userId ? Prisma.sql`AND userId = ${userId}` : Prisma.empty}
      GROUP BY DATE(createdAt)
      ORDER BY day ASC`);
    const map = new Map(rows.map((r) => [toDay(r.day), r]));
    const out: { day: string; requests: number; inputTokens: number; outputTokens: number; cost: number; errors: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      const key = toDay(d);
      const r = map.get(key);
      out.push({
        day: key,
        requests: Number(r?.requests ?? 0),
        inputTokens: Number(r?.inputTokens ?? 0),
        outputTokens: Number(r?.outputTokens ?? 0),
        cost: Number(r?.cost ?? 0),
        errors: Number(r?.errors ?? 0),
      });
    }
    return out;
  }

  async byModel(days: number, userId?: string) {
    const from = rangeFrom(days);
    const groups = await this.prisma.usageLog.groupBy({
      by: ['modelId'],
      where: { createdAt: { gte: from }, ...(userId ? { userId } : {}) },
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _avg: { latencyMs: true },
      _count: { _all: true },
    });
    const errors = await this.prisma.usageLog.groupBy({
      by: ['modelId'],
      where: { createdAt: { gte: from }, status: 'ERROR', ...(userId ? { userId } : {}) },
      _count: { _all: true },
    });
    const models = await this.prisma.aIModel.findMany({
      where: { id: { in: groups.map((g) => g.modelId) } },
      select: { id: true, displayName: true, provider: true, modelName: true },
    });
    return groups
      .map((g) => {
        const m = models.find((x) => x.id === g.modelId);
        const err = errors.find((e) => e.modelId === g.modelId)?._count._all ?? 0;
        return {
          modelId: g.modelId,
          displayName: m?.displayName ?? '(model dihapus)',
          provider: m?.provider ?? '-',
          modelName: m?.modelName ?? '-',
          requests: g._count._all,
          inputTokens: g._sum.inputTokens ?? 0,
          outputTokens: g._sum.outputTokens ?? 0,
          cost: Number(g._sum.estimatedCost ?? 0),
          avgLatencyMs: Math.round(g._avg.latencyMs ?? 0),
          errorRate: g._count._all ? err / g._count._all : 0,
        };
      })
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests);
  }

  async totals(days: number, userId?: string) {
    const from = rangeFrom(days);
    const agg = await this.prisma.usageLog.aggregate({
      where: { createdAt: { gte: from }, ...(userId ? { userId } : {}) },
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      _count: { _all: true },
    });
    return {
      requests: agg._count._all,
      inputTokens: agg._sum.inputTokens ?? 0,
      outputTokens: agg._sum.outputTokens ?? 0,
      cost: Number(agg._sum.estimatedCost ?? 0),
    };
  }
}

function toDay(d: Date | string) {
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
