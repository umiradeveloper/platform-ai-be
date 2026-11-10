import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';

/**
 * Login dengan akun SuperApps Umira.
 *
 * Backend membaca tabel `users` + `role` milik database SuperApps secara READ-ONLY saat login,
 * lalu mencocokkan password (bcrypt $2a/$2b) — password tidak pernah disalin ke database Umira.
 *
 * Aturan akses (bisa diubah lewat .env):
 *  - SUPERAPPS_DENY_ROLE_CODES  (default "01,41" = Vendor, Kandidat) → ditolak
 *  - akun harus isApproval = 1 dan punya role
 *  - SUPERAPPS_ADMIN_ROLE_CODES (default "99,80,31" = Admin/Chief IT/IT Engineer, CTO, CEO) → ADMIN di Umira
 */
export interface SuperAppsUser {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  roleCode: string | null;
  roleName: string | null;
  approved: boolean;
}

export type SuperAppsCheck =
  | { status: 'disabled' }
  | { status: 'unavailable'; error: string }
  | { status: 'not_found' }
  | { status: 'wrong_password'; user: SuperAppsUser }
  | { status: 'forbidden'; user: SuperAppsUser; reason: string }
  | { status: 'ok'; user: SuperAppsUser; isAdmin: boolean };

interface Row extends RowDataPacket {
  id_user: string;
  nama: string | null;
  email: string | null;
  username: string | null;
  password: string | null;
  isApproval: number | null;
  kode_role: string | null;
  nama_role: string | null;
}

/**
 * Di SuperApps, kolom `nama` karyawan internal umumnya berisi nama perusahaan ("PT Umira Sinergi Global")
 * sedangkan nama orangnya ada di `username`. Pakai username bila `nama` tampak seperti nama badan usaha / kosong.
 */
function displayName(r: { nama: string | null; username: string | null; email: string | null }): string {
  const nama = r.nama?.trim() ?? '';
  const user = r.username?.trim() ?? '';
  const looksCompany = !nama || /^null$/i.test(nama) || /^(pt|cv|ud|pd)\b\.?\s/i.test(nama) || /umira sinergi/i.test(nama);
  const name = looksCompany && user ? user : nama || user || r.email?.trim() || 'Pengguna SuperApps';
  return name.slice(0, 100);
}

const list = (v: string | undefined, def: string) =>
  (v ?? def)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

@Injectable()
export class SuperAppsService implements OnModuleDestroy {
  private readonly logger = new Logger(SuperAppsService.name);
  private pool: Pool | null = null;
  private readonly denyRoles = list(process.env.SUPERAPPS_DENY_ROLE_CODES, '01,41');
  private readonly adminRoles = list(process.env.SUPERAPPS_ADMIN_ROLE_CODES, '99,80,31');

  constructor() {
    const url = process.env.SUPERAPPS_DB_URL?.trim();
    if (!url) return;
    this.pool = createPool({
      uri: url,
      connectionLimit: Number(process.env.SUPERAPPS_DB_POOL ?? 5),
      connectTimeout: 8000,
      enableKeepAlive: true,
      charset: 'utf8mb4',
    });
    this.logger.log(`Login SuperApps aktif (role ditolak: ${this.denyRoles.join(',')} · role admin: ${this.adminRoles.join(',')}).`);
  }

  get enabled() {
    return !!this.pool;
  }

  async onModuleDestroy() {
    await this.pool?.end().catch(() => undefined);
  }

  private toUser(r: Row): SuperAppsUser {
    return {
      id: r.id_user,
      name: displayName(r),
      email: r.email?.trim().toLowerCase() || null,
      username: r.username?.trim() || null,
      roleCode: r.kode_role?.trim() || null,
      roleName: r.nama_role?.trim() || null,
      approved: Number(r.isApproval) === 1,
    };
  }

  private access(u: SuperAppsUser): { ok: true; isAdmin: boolean } | { ok: false; reason: string } {
    if (!u.roleCode) return { ok: false, reason: 'Akun SuperApps Anda belum memiliki role.' };
    if (this.denyRoles.includes(u.roleCode)) return { ok: false, reason: `Role SuperApps "${u.roleName ?? u.roleCode}" tidak memiliki akses ke Umira AI.` };
    if (!u.approved) return { ok: false, reason: 'Akun SuperApps Anda belum disetujui (approval).' };
    return { ok: true, isAdmin: this.adminRoles.includes(u.roleCode) };
  }

  private readonly baseQuery = `
    SELECT u.id_user, u.nama, u.email, u.username, u.password, u.isApproval, r.kode_role, r.nama_role
    FROM users u LEFT JOIN role r ON r.id_role = u.id_role`;

  /** Login: cari berdasarkan email ATAU username (tanpa beda huruf besar/kecil), lalu cek bcrypt. */
  async verify(identifier: string, password: string): Promise<SuperAppsCheck> {
    if (!this.pool) return { status: 'disabled' };
    const id = identifier.trim().toLowerCase();
    let rows: Row[];
    try {
      [rows] = await this.pool.query<Row[]>(
        `${this.baseQuery} WHERE LOWER(TRIM(u.email)) = ? OR LOWER(TRIM(u.username)) = ? LIMIT 10`,
        [id, id],
      );
    } catch (e) {
      this.logger.error(`DB SuperApps tidak dapat diakses: ${e.message}`);
      return { status: 'unavailable', error: e.message };
    }
    if (!rows.length) return { status: 'not_found' };

    // Bisa ada >1 baris (email ganda). Ambil yang passwordnya cocok, utamakan yang punya akses.
    const matches: Row[] = [];
    for (const r of rows) {
      if (r.password && /^\$2[aby]\$/.test(r.password) && (await bcrypt.compare(password, r.password))) matches.push(r);
    }
    if (!matches.length) return { status: 'wrong_password', user: this.toUser(rows[0]) };
    const candidates = matches.map((r) => ({ user: this.toUser(r) })).map((c) => ({ ...c, access: this.access(c.user) }));
    const allowed = candidates.find((c) => c.access.ok);
    if (allowed && allowed.access.ok) return { status: 'ok', user: allowed.user, isAdmin: allowed.access.isAdmin };
    const first = candidates[0];
    return { status: 'forbidden', user: first.user, reason: first.access.ok ? '' : first.access.reason };
  }

  /** Dipakai saat refresh token: pastikan akun masih ada & masih berhak (dicabut di SuperApps → ikut tercabut). */
  async recheck(externalId: string): Promise<SuperAppsCheck> {
    if (!this.pool) return { status: 'disabled' };
    try {
      const [rows] = await this.pool.query<Row[]>(`${this.baseQuery} WHERE u.id_user = ? LIMIT 1`, [externalId]);
      if (!rows.length) return { status: 'not_found' };
      const user = this.toUser(rows[0]);
      const a = this.access(user);
      return a.ok ? { status: 'ok', user, isAdmin: a.isAdmin } : { status: 'forbidden', user, reason: a.reason };
    } catch (e) {
      return { status: 'unavailable', error: e.message };
    }
  }

  /** Cek koneksi — untuk endpoint health/admin. */
  async ping(): Promise<'ok' | 'down' | 'disabled'> {
    if (!this.pool) return 'disabled';
    try {
      await this.pool.query('SELECT 1 FROM users LIMIT 1');
      return 'ok';
    } catch {
      return 'down';
    }
  }

  async emailExists(email: string): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const [rows] = await this.pool.query<Row[]>('SELECT id_user FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1', [email.trim().toLowerCase()]);
      return rows.length > 0;
    } catch {
      return false;
    }
  }
}
