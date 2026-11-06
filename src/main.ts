import './load-env'; // harus paling atas: memuat .env sebelum modul lain dibaca
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

function assertEnv() {
  const missing = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'APP_ENCRYPTION_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Environment variable wajib belum di-set: ${missing.join(', ')}`);
  if ((process.env.JWT_ACCESS_SECRET ?? '').length < 32) Logger.warn('JWT_ACCESS_SECRET sebaiknya minimal 32 karakter acak.', 'Bootstrap');
}

async function bootstrap() {
  assertEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.set('trust proxy', 1); // di belakang Nginx
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '2mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.enableShutdownHooks();

  if (process.env.SWAGGER_ENABLED !== 'false') {
    const doc = new DocumentBuilder()
      .setTitle('Umira AI Assistant Platform API')
      .setDescription('REST API + SSE streaming. Base URL: /api/v1')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, process.env.API_HOST ?? '0.0.0.0');
  Logger.log(`API berjalan di http://localhost:${port}/api/v1 — Swagger: /api/docs`, 'Bootstrap');
}

bootstrap();
