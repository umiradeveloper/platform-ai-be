import { BadRequestException, Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/auth.decorators';
import { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './auth.dto';
import { AuthService } from './auth.service';

const COOKIE = 'umira_rt';

/**
 * Refresh token disimpan di cookie httpOnly milik domain BACKEND.
 *  - Frontend & backend satu "site" (mis. ai.umira.id + api.umira.id, atau localhost:3000 + localhost:4000)
 *    → COOKIE_SAMESITE=lax (default) sudah cukup.
 *  - Beda site sama sekali (mis. umira.vercel.app + api.umira.id) → COOKIE_SAMESITE=none + HTTPS (COOKIE_SECURE=true).
 */
function cookieOptions() {
  const sameSite = (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase() as 'lax' | 'strict' | 'none';
  return {
    httpOnly: true,
    secure: sameSite === 'none' || process.env.COOKIE_SECURE === 'true',
    sameSite,
    path: '/api/v1/auth',
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
}

function setRefreshCookie(res: Response, token: string, expires: Date) {
  res.cookie(COOKIE, token, { ...cookieOptions(), expires });
}

function meta(req: Request) {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

/**
 * Klien mobile (header `X-Client: mobile`) tidak memakai cookie: refresh token dikirim di body respons
 * dan dikirim balik di body `refresh`/`logout`, lalu disimpan di secure storage (Keychain/Keystore).
 * Klien web tetap memakai cookie httpOnly — body token hanya diterima bila header ini ada.
 */
const isMobile = (req: Request) => String(req.headers['x-client'] ?? '').toLowerCase() === 'mobile';

function issue(req: Request, res: Response, r: { accessToken: string; user: unknown; refreshToken: string; refreshExpiresAt: Date }) {
  if (isMobile(req)) return { accessToken: r.accessToken, user: r.user, refreshToken: r.refreshToken, refreshExpiresAt: r.refreshExpiresAt };
  setRefreshCookie(res, r.refreshToken, r.refreshExpiresAt);
  return { accessToken: r.accessToken, user: r.user };
}

function incomingRefresh(req: Request): string | undefined {
  if (isMobile(req) && typeof req.body?.refreshToken === 'string') return req.body.refreshToken;
  return req.cookies?.[COOKIE];
}

@ApiTags('Authentication')
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.register(dto.name, dto.email, dto.password, meta(req));
    return issue(req, res, r);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const identifier = (dto.identifier ?? dto.email ?? '').trim();
    if (!identifier) throw new BadRequestException('Email atau username wajib diisi');
    const r = await this.auth.login(identifier, dto.password, meta(req));
    return issue(req, res, r);
  }

  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const r = await this.auth.refresh(incomingRefresh(req), meta(req));
      return issue(req, res, r);
    } catch (e) {
      if (!isMobile(req)) res.clearCookie(COOKIE, cookieOptions());
      throw e;
    }
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(incomingRefresh(req));
    if (!isMobile(req)) res.clearCookie(COOKIE, cookieOptions());
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  async forgot(@Body() dto: ForgotPasswordDto) {
    await this.auth.forgotPassword(dto.email);
    return { ok: true, message: 'Jika email terdaftar, link reset password telah dikirim.' };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('reset-password')
  async reset(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.password);
    return { ok: true };
  }
}
