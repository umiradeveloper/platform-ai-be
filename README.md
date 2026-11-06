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
tools/         mock-hermes.mjs
```
