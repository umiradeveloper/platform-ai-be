# Umira AI — Backend (NestJS API)

Ini REST API + SSE streaming untuk **Umira AI Assistant Platform**. Backend ini bisa berdiri sendiri,
terpisah dari frontend (`../frontend`), dan terhubung ke **Hermes Agent** milik sendiri serta OpenAI,
Anthropic, Gemini, dan server lain yang kompatibel dengan OpenAI.

```
Frontend (Next.js) ──HTTPS──► Backend :4000  /api/v1
                                 ├─ Hermes Agent   (http://127.0.0.1:8642/v1)
                                 ├─ OpenAI · Anthropic · Gemini · OpenAI-compatible
                                 ├─ MySQL 8 + Prisma
                                 └─ Redis (opsional)
```

Kebutuhan: **Node.js 22** dan **MySQL 8**. Redis opsional.

## Mulai cepat

**Mac:**
```bash
bash scripts/setup-mac.sh       # Node 22 + MySQL via Homebrew, DB, .env (secret otomatis), install, migrasi, seed
nano .env                       # HERMES_API_KEY (= API_SERVER_KEY Hermes), CORS_ORIGINS (= URL frontend)
npm run dev                     # http://localhost:4000/api/v1/health  ·  Swagger http://localhost:4000/api/docs
```

**Ubuntu VPS:**
```bash
sudo API_DOMAIN=api.umira.id FRONTEND_URL=https://ai.umira.id bash scripts/setup-ubuntu.sh
# → Node 22, MySQL, PM2 (auto-start), Nginx (deploy/nginx-api.conf), build, migrasi, seed
sudo certbot --nginx -d api.umira.id     # HTTPS → COOKIE_SECURE=true → npm run restart
```

**Manual:**
```bash
cp .env.example .env && nano .env
npm install && npm run db:migrate && npm run db:seed
npm run dev                     # atau production: npm run build && npm start (PM2)
```

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | API mode watch |
| `npm run build` · `npm start` | Build (API + seed), jalankan dengan PM2 (`umira-api`) |
| `npm run restart` · `stop` · `logs` · `update` | Kelola PM2. `update` = install, build, migrasi, restart |
| `npm run db:migrate` · `db:seed` · `db:studio` | Migrasi, seed (4 model + admin dari env), Prisma Studio |
| `npm run mock:hermes` | Hermes tiruan di :8642 (key `test-hermes-key`) untuk testing |

## Hubungan dengan frontend

Atur di `.env`:

| Variabel | Isi |
|---|---|
| `CORS_ORIGINS` | URL frontend, mis. `https://ai.umira.id`. Bisa lebih dari satu, pisahkan dengan koma |
| `APP_URL` | URL frontend, dipakai untuk link reset password |
| `COOKIE_SAMESITE` | `lax` bila frontend dan backend satu site (`ai.umira.id` + `api.umira.id`, atau localhost). `none` bila beda site; wajib HTTPS |
| `COOKIE_SECURE` | `true` setelah backend memakai HTTPS |
| `COOKIE_DOMAIN` | Opsional, mis. `.umira.id` |

Refresh token disimpan di cookie httpOnly milik domain backend. Access token hanya disimpan di memori
browser.

## Login dengan akun SuperApps

Karyawan bisa masuk ke Umira AI memakai **email atau username + password SuperApps** mereka. Backend
membaca tabel `users` dan `role` di database SuperApps secara **read-only** saat login, lalu
mencocokkan hash bcrypt. Password tidak pernah disalin ke database Umira.

| Aturan | Default (`.env`) |
|---|---|
| Ditolak | `SUPERAPPS_DENY_ROLE_CODES=01,41` (Vendor, Kandidat), akun dengan `isApproval ≠ 1`, dan akun tanpa role |
| Menjadi ADMIN di Umira | `SUPERAPPS_ADMIN_ROLE_CODES=99,80,31` (Admin / Chief IT / IT Engineer, CTO, CEO) |
| Role lain | USER |

- Akun yang dicabut di SuperApps (approval dibatalkan, role diganti ke Vendor, atau dihapus) kehilangan
  akses paling lambat saat access token berakhir (15 menit). Pada saat itu sesinya juga dicabut.
- Role dan nama mengikuti SuperApps. Nama diambil dari `username` bila kolom `nama` berisi nama
  perusahaan. Admin Umira tetap bisa menonaktifkan akun atau mengatur kuota token.
- Ganti atau lupa password dilakukan lewat SuperApps.
- Akun lokal Umira, misalnya admin dari seed, tetap bisa login, termasuk saat server SuperApps mati.
  Bila email akun lokal sama dengan email di SuperApps, akun itu otomatis ditautkan ke akun SuperApps.

**Membuat user read-only di MySQL SuperApps** (jalankan oleh DBA SuperApps, ganti IP dan password):

```sql
CREATE USER 'umira_ai_ro'@'<IP-server-backend-Umira>' IDENTIFIED BY '<password-kuat>';
GRANT SELECT (id_user, id_role, nama, username, password, email, isApproval) ON superapps.users TO 'umira_ai_ro'@'<IP-server-backend-Umira>';
GRANT SELECT ON superapps.role TO 'umira_ai_ro'@'<IP-server-backend-Umira>';
FLUSH PRIVILEGES;
```

Lalu di `backend/.env`:

```bash
SUPERAPPS_DB_URL=mysql://umira_ai_ro:<password-kuat>@<host-superapps>:<port>/superapps
```

Restart backend, lalu cek `GET /api/v1/health`. Hasilnya harus menunjukkan `"superapps":"ok"`.

## Synology NAS (per pengguna)

Setiap pengguna bisa menghubungkan **akun DSM Synology miliknya sendiri** di halaman Profil, lalu:

- **Melampirkan file NAS ke chat** (maksimal 5 file per pesan) lewat tombol *Synology* di kotak chat.
  Pengguna bisa menjelajah folder atau mencari file. Format yang didukung: PDF (teks), DOCX, XLSX, CSV/TSV,
  TXT/MD/JSON/XML/HTML/log. Isi file diekstrak menjadi teks, disimpan bersama pesan, dan dipakai sebagai
  konteks AI, termasuk saat *generate ulang*.
- **Menyimpan jawaban AI ke NAS** sebagai file Markdown, lewat tombol simpan di bawah jawaban.

Akses selalu memakai sesi akun DSM pengguna itu sendiri, sehingga Umira hanya bisa membuka folder yang
memang diizinkan untuk orang tersebut di NAS.

| Variabel | Default | Keterangan |
|---|---|---|
| `SYNOLOGY_URL` | kosong (nonaktif) | URL DSM, mis. `https://nas.umira.id:5001` |
| `SYNOLOGY_VERIFY_TLS` | `true` | `false` hanya untuk sertifikat self-signed di jaringan internal |
| `SYNOLOGY_SESSION` | `FileStation` | Isi `SynologyDrive` bila URL-nya portal aplikasi Synology Drive (mis. `https://drive.simumira.com`). Bila kosong, Umira beralih otomatis saat DSM membalas error 405 |
| `SYNOLOGY_ALLOW_REMEMBER_PASSWORD` | `true` | Mengizinkan opsi "Tetap tersambung" (password DSM disimpan terenkripsi AES-256-GCM) |
| `SYNOLOGY_MAX_FILE_MB` | `20` | Batas ukuran file yang diunduh |
| `SYNOLOGY_MAX_CHARS_PER_FILE` | `60000` | Batas teks per file. Sisanya dipotong dan ditandai |

**Sesi dan 2FA**

- Login memakai `SYNO.API.Auth` dengan `session=FileStation`. Yang disimpan adalah *sid* terenkripsi,
  bukan password, kecuali pengguna mencentang **Tetap tersambung**.
- Sesi DSM berlaku sekitar 7 hari (default DSM). Setelah itu:
  - pengguna dengan opsi *Tetap tersambung* disambung ulang otomatis;
  - pengguna lain diminta menghubungkan ulang.
- Akun ber-2FA diminta kode OTP sekali. Perangkat Umira lalu diingat lewat *device token*, sehingga OTP
  tidak diminta lagi saat menyambung ulang.

**Persiapan di NAS:**
1. File Station aktif, dan akun karyawan punya izin aplikasi File Station.
2. Server backend Umira bisa menjangkau port DSM (5001/HTTPS). Lewat LAN/VPN lebih baik daripada
   membukanya ke internet.
3. Bila Auto Block aktif, masukkan IP server Umira ke *allow list*, supaya password yang salah beberapa
   kali tidak memblokir semua pengguna.

**Testing tanpa NAS:** `node tools/mock-synology.mjs`, lalu set `SYNOLOGY_URL=http://127.0.0.1:5001`.
Akun tiruan: `rina`/`rina123` dan `budi`/`budi123` (2FA, OTP `123456`). Data dibaca dari
`tools/mock-synology-data/`.

## Integrasi Hermes Agent

`src/providers/hermes.adapter.ts` memanggil `POST {HERMES_BASE_URL}/chat/completions` (streaming) dengan
`Authorization: Bearer <API_SERVER_KEY>`:

- Event `hermes.tool.progress` diteruskan ke frontend sebagai event SSE `tool`, sehingga UI bisa
  menampilkan tool yang sedang dijalankan agent. Jejaknya disimpan di `Message.toolEvents`.
- Komunikasinya stateless: riwayat dikirim dari database Umira, jadi regenerate dan context management
  tetap konsisten.
- Dashboard → Konfigurasi API → **Test koneksi** memanggil `/v1/capabilities`.
- Bila Hermes gagal sebelum menjawab, chat otomatis pindah ke model fallback.

Siapkan Hermes:
```bash
# ~/.hermes/.env
API_SERVER_ENABLED=true
API_SERVER_KEY=<string-acak-panjang>      # = HERMES_API_KEY di backend/.env
# API_SERVER_HOST=0.0.0.0                 # hanya bila Hermes di server lain dari backend
hermes gateway
```

> ⚠️ Hermes dapat menjalankan terminal, membaca dan menulis file, serta melakukan web search di mesinnya.
> Atur izin dan approval tool di konfigurasi Hermes, dan jangan buka port 8642 ke internet.

## API (base `/api/v1`)

| Grup | Endpoint |
|---|---|
| Publik | `GET /health`, `GET /public/config` |
| Auth | `POST /auth/register` · `login` · `refresh` · `logout` · `forgot-password` · `reset-password` |
| Profil | `GET/PATCH /me`, `POST /me/password` |
| Percakapan | `POST/GET /conversations` (`?q=` cari), `GET/PATCH/DELETE /conversations/:id` |
| Chat | `POST /chat/completions`, `POST /chat/completions/stream` (SSE), `POST /chat/:id/regenerate` (SSE), `POST /chat/:id/stop` |
| Model | `GET /models` · admin: `GET/POST /admin/models`, `PATCH/DELETE /admin/models/:id` |
| Admin | `/admin/dashboard` · `users` · `providers` (+ `/:type/test`) · `usage` · `costs` · `audit-logs` · `settings` |
| Usage | `GET /usage/me` |
| Synology | `GET /synology/status`, `POST/DELETE /synology/connect`, `GET /synology/browse?path=`, `GET /synology/search?path=&q=`, `POST /synology/save-message` · lampiran: `synologyFiles[]` pada `POST /chat/completions(/stream)` |

Event SSE: `meta`, `title`, `delta {text}`, `tool {tool,label,status}`, `fallback`, `done`, `error`.
Dokumentasi interaktif tersedia di `/api/docs`, dan metrik Prometheus di `/metrics` (lihat
`deploy/prometheus.yml`).

## Struktur

```
src/
  auth/ users/ conversations/ chat/ models/ usage/ admin/ settings/
  providers/   adapter per provider: hermes, openai-compatible, anthropic, gemini
  common/      prisma, redis (opsional), guard JWT & role, audit, metrics, enkripsi
prisma/        schema.prisma, migrations/, seed.ts
scripts/       setup-mac.sh, setup-ubuntu.sh, init-env.mjs
deploy/        nginx-api.conf, prometheus.yml
synology/      (di src/) klien DSM API, ekstraksi teks file, endpoint per pengguna
tools/         mock-hermes.mjs, mock-synology.mjs
```
