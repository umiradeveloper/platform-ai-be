import { ConflictException, ForbiddenException, Injectable, Logger, UnauthorizedException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { User, UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { randomToken, sha256 } from '../common/crypto.util';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../common/audit.service';
import { SuperAppsService, SuperAppsUser } from './superapps.service';

const REFRESH_DAYS = Number(process.env.JWT_REFRESH_DAYS ?? 14);

export function publicUser(u: Pick<User, 'id' | 'name' | 'email' | 'role' | 'createdAt' | 'authSource' | 'externalRole'>) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt, authSource: u.authSource, externalRole: u.externalRole };
}

/** Hash pengganti untuk akun SuperApps — bukan hash argon2 yang valid, jadi tidak pernah bisa login lokal. */
const NO_LOCAL_PASSWORD = '!superapps';
const BAD_LOGIN = 'Email/username atau password salah';

async function verifyLocal(hash: string, password: string) {
  if (!hash.startsWith('$argon2')) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly superapps: SuperAppsService,
  ) {}

  get superappsEnabled() {
    return this.superapps.enabled;
  }

  async register(name: string, email: string, password: string, meta: SessionMeta) {
    const s = await this.settings.get();
    const userCount = await this.prisma.user.count();
    // Pengguna pertama otomatis menjadi ADMIN dan selalu boleh mendaftar.
    if (userCount > 0 && !s.allowRegistration) throw new ForbiddenException('Registrasi sedang ditutup oleh admin');

    const normalized = email.trim().toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (exists) throw new ConflictException('Email sudah terdaftar');
    if (await this.superapps.emailExists(normalized)) {
      throw new ConflictException('Email ini terdaftar di SuperApps — silakan masuk dengan akun SuperApps Anda.');
    }

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

  /**
   * Login dengan email ATAU username.
   * 1. Dicek ke DB SuperApps (bila SUPERAPPS_DB_URL di-set) — akun internal yang approved bisa masuk.
   * 2. Bila tidak ada di SuperApps, dicek ke akun lokal Umira (mis. admin awal dari seed).
   */
  async login(identifier: string, password: string, meta: SessionMeta) {
    const id = identifier.trim().toLowerCase();
    const sa = await this.superapps.verify(id, password);

    if (sa.status === 'ok') {
      const user = await this.syncSuperAppsUser(sa.user, sa.isAdmin, meta);
      return this.issueTokens(user, meta);
    }
    if (sa.status === 'forbidden') {
      await this.audit.log({ action: 'auth.superapps_denied', targetType: 'superapps_user', targetId: sa.user.id, metadata: { role: sa.user.roleName, reason: sa.reason }, ipAddress: meta.ip });
      throw new ForbiddenException(sa.reason);
    }

    // Fallback: akun lokal Umira
    const user = await this.prisma.user.findFirst({ where: { OR: [{ email: id }, { externalUsername: id }] } });
    if (!user && sa.status === 'unavailable') {
      throw new ServiceUnavailableException('Server SuperApps sedang tidak dapat dihubungi. Coba beberapa saat lagi.');
    }
    if (user?.authSource === 'SUPERAPPS') {
      if (sa.status === 'unavailable') throw new ServiceUnavailableException('Server SuperApps sedang tidak dapat dihubungi. Coba beberapa saat lagi.');
      throw new UnauthorizedException(BAD_LOGIN);
    }
    // Pesan sama untuk akun tidak ada / password salah agar tidak membocorkan akun terdaftar.
    if (!user || !(await verifyLocal(user.passwordHash, password))) throw new UnauthorizedException(BAD_LOGIN);
    if (!user.isActive) throw new ForbiddenException('Akun Anda dinonaktifkan. Hubungi administrator.');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(user, meta);
  }

  /** Buat / perbarui user lokal yang terhubung ke akun SuperApps. Role mengikuti SuperApps. */
  private async syncSuperAppsUser(sa: SuperAppsUser, isAdmin: boolean, meta: SessionMeta): Promise<User> {
    const role: UserRole = isAdmin ? 'ADMIN' : 'USER';
    const fallbackEmail = `${(sa.username ?? sa.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '.')}@superapps.local`;
    const email = sa.email ?? fallbackEmail;

    let user =
      (await this.prisma.user.findUnique({ where: { externalId: sa.id } })) ??
      (await this.prisma.user.findUnique({ where: { email } }));
    const linking = !!user && user.externalId !== sa.id;

    if (user && !user.isActive) throw new ForbiddenException('Akun Anda dinonaktifkan di Umira AI. Hubungi administrator.');

    const emailTaken = user && user.email !== email ? await this.prisma.user.findUnique({ where: { email } }) : null;
    const data = {
      name: sa.name,
      role,
      authSource: 'SUPERAPPS' as const,
      externalId: sa.id,
      externalRole: sa.roleName,
      externalUsername: sa.username,
      passwordHash: NO_LOCAL_PASSWORD,
      lastLoginAt: new Date(),
      ...(emailTaken ? {} : { email }),
    };
    if (user) {
      if (user.role !== role) {
        await this.audit.log({ actorId: user.id, action: 'auth.superapps_role_sync', targetType: 'user', targetId: user.id, metadata: { from: user.role, to: role, superappsRole: sa.roleName } });
      }
      user = await this.prisma.user.update({ where: { id: user.id }, data });
    }
    const created = !user;
    if (!user) user = await this.prisma.user.create({ data: { ...data, email } });
    if (linking || created) {
      await this.audit.log({ actorId: user.id, action: linking ? 'auth.superapps_link' : 'auth.superapps_first_login', targetType: 'user', targetId: user.id, metadata: { superappsRole: sa.roleName, role }, ipAddress: meta.ip });
    }
    return user;
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

    let user = record.user;
    if (user.authSource === 'SUPERAPPS' && user.externalId && this.superapps.enabled) {
      // Akun yang dicabut / diubah role-nya di SuperApps langsung berlaku di Umira saat sesi diperbarui.
      const chk = await this.superapps.recheck(user.externalId);
      if (chk.status === 'not_found' || chk.status === 'forbidden') {
        await this.prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
        throw new ForbiddenException(chk.status === 'forbidden' ? chk.reason : 'Akun SuperApps Anda tidak ditemukan.');
      }
      if (chk.status === 'ok') {
        const role: UserRole = chk.isAdmin ? 'ADMIN' : 'USER';
        if (role !== user.role || chk.user.roleName !== user.externalRole || chk.user.name !== user.name) {
          user = await this.prisma.user.update({ where: { id: user.id }, data: { role, externalRole: chk.user.roleName, name: chk.user.name } });
        }
      } else if (chk.status === 'unavailable') {
        this.logger.warn(`SuperApps tidak dapat dihubungi saat refresh user ${user.id}; sesi tetap diperpanjang.`);
      }
    }

    await this.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(user, meta);
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
    if (!user || !user.isActive || user.authSource === 'SUPERAPPS') return; // respons tetap sama
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
    if (user.authSource === 'SUPERAPPS') throw new BadRequestException('Password akun ini dikelola di SuperApps. Ubah password lewat aplikasi SuperApps.');
    if (!(await verifyLocal(user.passwordHash, current))) throw new BadRequestException('Password saat ini salah');
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
