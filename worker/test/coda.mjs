// Prova della coda di arricchimento in locale (tempi brevi da wrangler.test.jsonc: attesa 4s, riserva 8s, 2 avvii/giorno).
// Servono: finto Anthropic (:8790), worker di prova con --test-scheduled (:8787), connettore di prova (:8788).
// Uso: node test/coda.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const API = 'http://localhost:8787';
const FINTO = 'http://localhost:8790';
const TOKEN = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/CANTINA_TOKEN=(.+)/)[1].trim();
const ok = (cond, msg) => { if (!cond) throw new Error('FALLITO: ' + msg); console.log('✓', msg); };
const attendi = s => new Promise(r => setTimeout(r, s * 1000));

const api = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
};
const timer = () => fetch(API + '/__scheduled?cron=*%2F2+*+*+*+*').then(r => r.text());
const finto = async () => (await fetch(FINTO + '/_stato')).json();
const modo = m => fetch(FINTO + '/_modo', { method: 'POST', body: JSON.stringify(m) });
const vino = async id => api('GET', '/db/' + id);
// Il timer gira dentro waitUntil: aspetto che abbia finito prima di controllare
const timerECompleta = async (sec = 2) => { await timer(); await attendi(sec); };

// Azzera lo stato della coda (avvii del giorno) nel D1 locale
const azzeraMeta = () => execSync(`npx wrangler d1 execute cantina-test --local -c wrangler.test.jsonc --command "DELETE FROM kv WHERE chiave='coda_meta'"`, { cwd: new URL('..', import.meta.url), stdio: 'ignore' });

// Vini di prova nuovi a ogni esecuzione
const crea = async nome => (await api('POST', '/db', { azienda: 'Prova Coda', bottiglia: nome + ' ' + Date.now(), tipo: 'Rosso', vendemmia: 2020, inStock: true, riconteggio: 1 })).id;

// Stato pulito: niente avvii registrati oggi
azzeraMeta();
await fetch(FINTO + '/_azzera', { method: 'POST' });
await modo({ fire: 'ok', messages: 'ok' });

// A. Percorso Claude: attesa, un avvio, Claude completa, nessuna riserva
const a = await crea('A');
let w = await api('POST', `/db/${a}/enrich`);
ok(w.aiStato === 'coda' && w.aiCodaDal, 'A: messo in coda');
await timerECompleta();
ok((await finto()).fire.length === 0, 'A: durante l\'attesa Claude non parte');
await attendi(4);
await timerECompleta();
let f = await finto();
ok(f.fire.length === 1 && f.fire[0].text.includes(a), 'A: dopo l\'attesa parte un avvio con il vino in elenco');
ok(f.fire[0].auth === 'Bearer finto-token-routine' && f.fire[0].version, 'A: avvio con token della routine e anthropic-version');
// Claude completa dal connettore (come farebbe l'attività)
await api('PATCH', `/db/${a}`, { finestraBevuta: { start: 2024, peak: 2027, end: 2032 }, abbinamenti: ['x'], aiEnriched: true, aiStato: 'claude', aiCodaDal: null });
await attendi(9);
await timerECompleta();
ok((await finto()).messages.length === 0 && (await vino(a)).aiStato === 'claude', 'A: completato da Claude, nessuna riserva a crediti');

// B. Due vini a breve distanza: un solo avvio per entrambi
const b1 = await crea('B1'); await api('POST', `/db/${b1}/enrich`);
await attendi(2);
const b2 = await crea('B2'); await api('POST', `/db/${b2}/enrich`);
await attendi(2.5);
await timerECompleta();
ok((await finto()).fire.length === 1, 'B: l\'attesa riparte dall\'ultimo vino aggiunto');
await attendi(3);
await timerECompleta();
f = await finto();
ok(f.fire.length === 2 && f.fire[1].text.includes(b1) && f.fire[1].text.includes(b2), 'B: un solo avvio per due vini');

// C. Claude non completa: dopo la riserva passa a Sonnet a crediti
await attendi(9);
await timerECompleta(3);
f = await finto();
const [vb1, vb2] = [await vino(b1), await vino(b2)];
ok(f.messages.length === 2 && f.messages.every(m => m.model === 'claude-sonnet-5-5'), 'C: riserva con Sonnet per i due vini non completati');
ok(vb1.aiStato === 'riserva' && vb2.aiStato === 'riserva' && vb1.finestraBevuta.peak === 2028 && vb1.aiLivello === 2, 'C: risultati della riserva salvati nel formato dell\'app');

// D. Tetto giornaliero (2 avvii già usati): riserva immediata, nessun avvio
const d = await crea('D'); await api('POST', `/db/${d}/enrich`);
await attendi(4.5);
await timerECompleta(3);
f = await finto();
ok(f.fire.length === 2 && (await vino(d)).aiStato === 'riserva', 'D: tetto raggiunto, riserva subito senza avviare Claude');

// E. Avvio rifiutato (abbonamento esaurito / limite): riserva immediata
azzeraMeta();
await modo({ fire: 'rifiuta' });
const e = await crea('E'); await api('POST', `/db/${e}/enrich`);
await attendi(4.5);
await timerECompleta(3);
f = await finto();
ok(f.fire.length === 3 && (await vino(e)).aiStato === 'riserva', 'E: avvio rifiutato (429), riserva subito');

// F. Anche la riserva fallisce: il vino resta segnalato come errore, non si perde
await modo({ fire: 'rifiuta', messages: 'errore' });
const g = await crea('F'); await api('POST', `/db/${g}/enrich`);
await attendi(4.5);
await timerECompleta(3);
const vg = await vino(g);
ok(vg.aiStato === 'errore' && /Claude API error/.test(vg.aiErrore), 'F: riserva fallita, vino segnato come errore con il motivo');

// G. Pulsante "Avvia Claude ora": parte subito, senza attesa, e non riparte due volte
azzeraMeta();
await modo({ fire: 'ok', messages: 'ok' });
const avvii = (await finto()).fire.length;
const h = await crea('G'); await api('POST', `/db/${h}/enrich`);
let r = await api('POST', '/coda/avvia');
f = await finto();
ok(r.esito.ok && f.fire.length === avvii + 1 && f.fire.at(-1).text.includes(h), 'G: "Avvia ora" parte subito, senza aspettare');
r = await api('POST', '/coda/avvia');
ok(!r.esito.ok && (await finto()).fire.length === avvii + 1, 'G: secondo clic non fa ripartire Claude (' + r.esito.motivo + ')');

// H. "Avvia ora" con Claude non disponibile: risponde subito e la riserva parte in background
await modo({ fire: 'rifiuta' });
const k = await crea('H'); await api('POST', `/db/${k}/enrich`);
r = await api('POST', '/coda/avvia');
ok(!r.esito.ok && r.riserva === 1, 'H: avvio rifiutato, risposta immediata con riserva in corso');
await attendi(2);
ok((await vino(k)).aiStato === 'riserva', 'H: la riserva in background ha completato il vino');

await modo({ fire: 'ok', messages: 'ok' });
console.log('\nTutto ok: Claude prima, riserva dopo l\'attesa, tetto giornaliero, avvio rifiutato, errori e "Avvia ora".');
