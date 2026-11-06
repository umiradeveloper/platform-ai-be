import { existsSync } from 'fs';
import { resolve } from 'path';

// Muat .env dari folder backend. Variabel yang sudah ada di environment (PM2/systemd) tidak ditimpa.
for (const f of [resolve(process.cwd(), '.env'), resolve(__dirname, '../.env')]) {
  if (existsSync(f)) {
    process.loadEnvFile(f);
    break;
  }
}
