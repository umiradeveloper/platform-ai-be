import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { AdminController } from './admin/admin.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { AuditModule } from './common/audit.service';
import { JwtAuthGuard, Public } from './common/auth.decorators';
import { MetricsModule } from './common/metrics';
import { PrismaModule, PrismaService } from './common/prisma.service';
import { RedisModule, RedisService, RedisThrottlerStorage } from './common/redis.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ModelsController } from './models/models.controller';
import { ProvidersModule } from './providers/provider.registry';
import { SettingsModule, SettingsService } from './settings/settings.service';
import { UsageController } from './usage/usage.controller';
import { UsageService } from './usage/usage.service';
import { UsersController } from './users/users.controller';

@ApiTags('Health')
@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly settings: SettingsService) {}

  @Public()
  @Get('health')
  async health() {
    const db = await this.prisma.$queryRaw`SELECT 1`.then(() => 'ok').catch(() => 'down');
    const redis = this.redis.client ? await this.redis.client.ping().then(() => 'ok').catch(() => 'down') : 'disabled (in-memory)';
    return { status: db === 'ok' ? 'ok' : 'degraded', db, redis, time: new Date().toISOString() };
  }

  /** Info publik untuk halaman login (nama aplikasi & status registrasi). */
  @Public()
  @Get('public/config')
  async config() {
    const s = await this.settings.get();
    const hasUsers = (await this.prisma.user.count()) > 0;
    return { appName: s.appName, allowRegistration: s.allowRegistration || !hasUsers };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), // env sudah dimuat di main.ts
    PrismaModule,
    RedisModule,
    AuditModule,
    SettingsModule,
    ProvidersModule,
    MetricsModule,
    JwtModule.register({}),
    ThrottlerModule.forRootAsync({
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120) }],
        storage,
      }),
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    ConversationsController,
    ChatController,
    ModelsController,
    UsageController,
    AdminController,
  ],
  providers: [
    AuthService,
    ChatService,
    UsageService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
