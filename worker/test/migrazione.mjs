// Prova del passaggio da KV a D1 e dei salvataggi simultanei, in locale.
// Prima: KV locale caricato con la copia di produzione, D1 locale vuoto con la tabella kv.
// Serve il worker di prova su :8787 (wrangler dev -c worker/wrangler.test.jsonc).
// Uso: node test/migrazione.mjs
import { readFileSync } from 'node:fs';

const API = 'http://localhost:8787';
const TOKEN = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/CANTINA_TOKEN=(.+)/)[1].trim();
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const ok = (cond, msg) => { if (!cond) throw new Error('FALLITO: ' + msg); console.log('✓', msg); };
const api = async (method, path, body) => (await fetch(API + path, { method, headers: H, body: body && JSON.stringify(body) })).json();

const kvDb = JSON.parse(readFileSync(new URL('../../backup/kv-2026-10-27T18-08-08/db.txt', import.meta.url), 'utf8'));

// 1. Prima della migrazione l'app vede i dati di KV, identici
let db = await api('GET', '/db');
ok(JSON.stringify(db) === JSON.stringify(kvDb), `prima della migrazione: letti da KV ${db.wines.length} vini identici alla copia`);

// 2. Il primo salvataggio va su D1 e da lì in poi si legge D1
const primo = db.wines.find(w => w.inStock);
await api('PATCH', '/db/' + primo.id, { utilizzo: (primo.utilizzo || '') + ' [prova D1]' });
db = await api('GET', '/db');
ok(db.wines.find(w => w.id === primo.id).utilizzo.endsWith('[prova D1]') && db.wines.length === kvDb.wines.length, 'primo salvataggio scritto su D1 senza perdere vini');

// 3. Migrazione: copia ciò che manca, non sovrascrive il db già aggiornato in D1
let m = await api('POST', '/admin/migra');
const rigaDb = m.report.find(r => r.chiave === 'db');
ok(m.tutteInD1 && rigaDb.azione === 'già in D1' && !rigaDb.uguale, `migrazione: ${m.chiavi} chiavi in D1, il db aggiornato non è stato sovrascritto`);
ok(m.report.filter(r => r.chiave !== 'db').every(r => r.uguale), 'snapshot e stato coda copiati identici');
m = await api('POST', '/admin/migra?chiudi=1');
ok(m.chiusa, 'migrazione chiusa: da qui si usa solo D1');
const snap = await api('GET', '/snapshots');
ok(snap.snapshots.length >= 21, `snapshot letti da D1: ${snap.snapshots.length}`);

// 4. Salvataggi simultanei: 10 vini diversi modificati nello stesso istante
const dieci = db.wines.filter(w => w.inStock).slice(0, 10);
const marca = 'conc-' + Date.now();
await Promise.all(dieci.map(w => api('PATCH', '/db/' + w.id, { aiNote: marca })));
db = await api('GET', '/db');
const salvati = dieci.filter(w => db.wines.find(x => x.id === w.id).aiNote === marca).length;
ok(salvati === 10, `10 salvataggi simultanei su vini diversi: arrivati tutti (${salvati}/10)`);

// 5. Stesso vino: 6 bottiglie aggiunte in parallelo, poi 6 tolte in parallelo
const v = dieci[0];
const prima = db.wines.find(x => x.id === v.id);
await Promise.all(Array.from({ length: 6 }, () => api('POST', `/db/${v.id}/increment`)));
await Promise.all(Array.from({ length: 6 }, () => api('POST', `/db/${v.id}/decrement`)));
const dopo = (await api('GET', '/db')).wines.find(x => x.id === v.id);
ok(dopo.riconteggio === prima.riconteggio && (dopo.bevute || []).length === (prima.bevute || []).length + 6,
  `stesso vino, 12 operazioni simultanee: bottiglie ${prima.riconteggio} → ${dopo.riconteggio}, 6 bevute registrate`);

console.log('\nTutto ok: migrazione senza perdite e nessun salvataggio perso in parallelo.');
