// Backup completo della cantina dal Worker Cloudflare.
// Uso: node tools/backup.mjs   (legge CANTINA_API_URL e CANTINA_TOKEN da .env)
// Salva in backup/<data>/: db.json, snapshots.json, snapshot_<data>.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const baseUrl = (env.CANTINA_API_URL || '').replace(/\/$/, '');
const token = env.CANTINA_TOKEN || '';
if (!baseUrl || !token) {
  console.error('Compila CANTINA_API_URL e CANTINA_TOKEN nel file .env');
  process.exit(1);
}

async function get(path) {
  const res = await fetch(baseUrl + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

const outDir = join(root, 'backup', new Date().toISOString().slice(0, 10));
mkdirSync(outDir, { recursive: true });
const save = (name, data) => writeFileSync(join(outDir, name), JSON.stringify(data, null, 2));

const db = await get('/db');
save('db.json', db);
const wines = db.wines || [];
console.log(`db.json: ${wines.length} vini (${wines.filter(w => w.inStock).length} in cantina)`);

const list = await get('/snapshots');
save('snapshots.json', list);
const dates = (Array.isArray(list) ? list : list.snapshots || [])
  .map(s => (typeof s === 'string' ? s : s.date))
  .filter(Boolean);
for (const date of dates) {
  save(`snapshot_${date}.json`, await get('/snapshots/' + encodeURIComponent(date)));
}
console.log(`snapshot scaricati: ${dates.length}`);
console.log('Salvato in ' + outDir);
