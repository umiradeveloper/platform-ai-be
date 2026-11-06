// PM2 — Umira AI backend.   npm run build && npm start
// Env dibaca dari backend/.env (src/load-env.ts).
module.exports = {
  apps: [
    {
      name: 'umira-api',
      cwd: __dirname,
      script: 'dist/main.js',
      // 1 instance cukup. Untuk >1 instance / cluster WAJIB isi REDIS_URL.
      instances: 1,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
  ],
};
