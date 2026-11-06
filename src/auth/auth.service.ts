import { ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { User } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { randomToken, sha256 } from '../common/crypto.util';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../common/audit.service';

const REFRESH_DAYS = Number(process.env.JWT_REFRESH_DAYS ?? 14);

export function publicUser(u: Pick<User, 'id' | 'name' | 'email' | 'role' | 'createdAt'>) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async register(name: string, email: string, password: string, meta: SessionMeta) {
    const s = await this.settings.get();
    const userCount = await this.prisma.user.count();
    // Pengguna pertama otomatis menjadi ADMIN dan selalu boleh mendaftar.
    if (userCount > 0 && !s.allowRegistration) throw new ForbiddenException('Registrasi sedang ditutup oleh admin');

    const normalized = email.trim().toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (exists) throw new ConflictException('Email sudah terdaftar');

    const user = await this.prisma.user.create({
      data: {
        name: name.trim(),
        email: normalized,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        role: userCount === 0 ? 'ADMIN' : 'USER',
      },
    });
    return this.issueTokens(user, meta);
  }

  async login(email: string, password: string, meta: SessionMeta) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Pesan sama untuk email/password salah agar tidak membocorkan email terdaftar.
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Email atau password salah');
    }
    if (!user.isActive) throw new ForbiddenException('Akun Anda dinonaktifkan. Hubungi administrator.');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(user, meta);
  }

  /** Rotasi refresh token: token lama dicabut, token baru diterbitkan. Reuse token lama → semua sesi dicabut. */
  async refresh(rawToken: string | undefined, meta: SessionMeta) {
    if (!rawToken) throw new UnauthorizedException('Refresh token tidak ada');
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: true },
    });
    if (!record) throw new UnauthorizedException('Sesi tidak valid');
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      this.logger.warn(`Refresh token reuse terdeteksi untuk user ${record.userId}; semua sesi dicabut.`);
      throw new UnauthorizedException('Sesi tidak valid');
    }
    if (record.expiresAt < new Date()) throw new UnauthorizedException('Sesi kedaluwarsa');
    if (!record.user.isActive) throw new ForbiddenException('Akun dinonaktifkan');

    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(record.user, meta);
  }

  async logout(rawToken: string | undefined) {
    if (!rawToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !user.isActive) return; // respons tetap sama
    const token = randomToken(32);
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) },
    });
    const link = `${process.env.APP_URL ?? 'http://localhost:3000'}/reset-password?token=${token}`;
    // TODO: kirim via email (SMTP) — untuk MVP link dicatat di log server.
    this.logger.log(`Link reset password untuk ${user.email}: ${link}`);
  }

  async resetPassword(token: string, password: string) {
    const rec = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw new BadRequestException('Token reset tidak valid atau kedaluwarsa');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: rec.userId },
        data: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }) },
      }),
      this.prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({ where: { userId: rec.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ actorId: rec.userId, action: 'auth.password_reset', targetType: 'user', targetId: rec.userId });
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, current))) throw new BadRequestException('Password saat ini salah');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(next, { type: argon2.argon2id }) },
    });
  }

  private async issueTokens(user: User, meta: SessionMeta) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: (process.env.JWT_ACCESS_TTL ?? '15m') as any },
    );
    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 500),
        ipAddress: meta.ip,
      },
    });
    return { accessToken, refreshToken, refreshExpiresAt: expiresAt, user: publicUser(user) };
  }
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}
