import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { PrismaService } from '../common/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { UsageService } from './usage.service';

export const clampDays = (d?: string) => Math.min(Math.max(Number(d) || 30, 1), 365);

@ApiTags('Usage')
@ApiBearerAuth()
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService, private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  @ApiQuery({ name: 'days', required: false })
  @Get('me')
  async me(@CurrentUser() u: AuthUser, @Query('days') days?: string) {
    const d = clampDays(days);
    const [totals, daily, byModel, today, user, s] = await Promise.all([
      this.usage.totals(d, u.id),
      this.usage.daily(d, u.id),
      this.usage.byModel(d, u.id),
      this.usage.totals(1, u.id),
      this.prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { dailyTokenLimit: true } }),
      this.settings.get(),
    ]);
    const limit = user.dailyTokenLimit ?? s.defaultDailyTokenLimit;
    return {
      days: d,
      totals,
      daily,
      byModel,
      today: { tokens: today.inputTokens + today.outputTokens, limit: limit || null },
    };
  }
}
