// Copia grezza di TUTTE le chiavi dell'archivio KV della cantina (valori esattamente come sono).
// Uso: node tools/dump-kv.mjs   → backup/kv-<data-ora>/  (un file per chiave + indice.json)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAMESPACE = 'cd8096b3df154ec89e43a15c5a81625d';
const wrangler = args => execFileSync('npx', ['--yes', 'wrangler@4', ...args], { cwd: join(root, 'worker'), shell: true, maxBuffer: 64 * 1024 * 1024 }).toString();

const elenco = JSON.parse(wrangler(['kv', 'key', 'list', '--namespace-id', NAMESPACE, '--remote']).replace(/^[^[]*/, ''));
const dir = join(root, 'backup', 'kv-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
mkdirSync(dir, { recursive: true });
const indice = [];
for (const { name } of elenco) {
  const valore = wrangler(['kv', 'key', 'get', JSON.stringify(name), '--namespace-id', NAMESPACE, '--remote', '--text']);
  const file = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt';
  writeFileSync(join(dir, file), valore);
  indice.push({ chiave: name, file, byte: Buffer.byteLength(valore) });
}
writeFileSync(join(dir, 'indice.json'), JSON.stringify(indice, null, 2));
console.log(`${indice.length} chiavi salvate in ${dir}`);
for (const i of indice) console.log(' ', i.chiave.padEnd(24), i.byte, 'byte');
