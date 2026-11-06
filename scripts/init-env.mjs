// Membuat backend/.env dari .env.example (bila belum ada) dan mengisi secret acak.
// Pemakaian: node scripts/init-env.mjs [--db-pass=xxx] [--frontend-url=https://ai.umira.id] [--api-host=127.0.0.1] [--cookie-secure=true]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, ...v]) => [k, v.join('=')]));

if (!existsSync(envPath)) {
  copyFileSync(resolve(root, '.env.example'), envPath);
  console.log('✓ .env dibuat dari .env.example');
}

let env = readFileSync(envPath, 'utf8');
const set = (key, value, onlyIfPlaceholder = false) => {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = env.match(re);
  if (m && onlyIfPlaceholder && !/^ganti-|^$/.test(m[1])) return;
  env = m ? env.replace(re, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
};
const secret = () => randomBytes(36).toString('base64url');

set('JWT_ACCESS_SECRET', secret(), true);
set('APP_ENCRYPTION_KEY', secret(), true);
if (args['db-pass']) set('DATABASE_URL', `mysql://umira:${encodeURIComponent(args['db-pass'])}@127.0.0.1:3306/umira_ai`);
if (args['frontend-url']) {
  set('CORS_ORIGINS', args['frontend-url']);
  set('APP_URL', args['frontend-url']);
}
if (args['api-host']) set('API_HOST', args['api-host']);
if (args['cookie-secure']) set('COOKIE_SECURE', args['cookie-secure']);

writeFileSync(envPath, env);
console.log('✓ Secret JWT & enkripsi terisi. Periksa HERMES_BASE_URL, HERMES_API_KEY & CORS_ORIGINS di .env');
