// ═══════════════════════════════════════════════════════════
// CANTINA WORKER v22 — Online-only + snapshot giornalieri
// 
// Endpoint:
// GET    /db                    → tutti i vini
// GET    /db/:id                → un vino
// POST   /db                    → crea vino
// PATCH  /db/:id                → modifica parziale
// DELETE /db/:id                → elimina definitivamente
// POST   /db/:id/increment      → +1 bottiglia
// POST   /db/:id/decrement      → -1 bottiglia
// POST   /db/:id/markout        → sposta nello storico
// POST   /db/:id/markin         → rimetti in cantina
// POST   /db/:id/enrich         → metti in coda per l'arricchimento (prima Claude, poi riserva)
// POST   /coda/avvia            → avvia subito Claude sui vini in coda, senza attesa
// GET    /consumi               → bottiglie e valore per snapshot + date delle bevute registrate
// POST   /ai                    → arricchimento AI immediato a crediti (Sonnet)
// GET    /snapshots             → lista date snapshot
// GET    /snapshots/:date       → scarica snapshot
// POST   /snapshots/:date/restore → ripristina snapshot
// 
// Tutti richiedono Authorization: Bearer <CANTINA_TOKEN>
// ═══════════════════════════════════════════════════════════

// Modello della riserva a crediti: entra in gioco solo se Claude (abbonamento) non arricchisce il vino
const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 2000;
const DB_KEY = 'db';
const SNAPSHOT_RETENTION_DAYS = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    env = { ...env, CANTINA_DB: archivio(env) };
    // Se un altro salvataggio si è infilato tra lettura e scrittura, la richiesta riparte da capo
    // dopo una pausa breve e casuale, così le richieste in conflitto non si riscontrano subito
    for (let tentativo = 1; ; tentativo++) {
      try {
        return await gestisci(request.clone(), env, ctx);
      } catch (e) {
        if (!(e instanceof ConflittoDB)) throw e;
        if (tentativo >= 12) return jsonError('Salvataggio in conflitto con un altro, riprova', 409);
        await new Promise(r => setTimeout(r, 20 + Math.random() * 40 * tentativo));
      }
    }
  },

  // Timer (cron in wrangler.jsonc): avvia Claude sui vini in coda o passa alla riserva
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processaCoda({ ...env, CANTINA_DB: archivio(env) }));
  },
};

async function gestisci(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  // Auth
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!env.CANTINA_TOKEN) return jsonError('CANTINA_TOKEN not configured', 500);
  if (token !== env.CANTINA_TOKEN) return jsonError('Unauthorized', 401);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // AI
  if (path === '/ai' && method === 'POST') return handleAI(request, env);
  if (path === '/coda/avvia' && method === 'POST') return avviaOra(env, ctx);
  if (path === '/consumi' && method === 'GET') return consumi(env);
  if (path === '/admin/migra' && method === 'POST') return migraDaKV(env, url);

  // Snapshots
  if (path === '/snapshots' && method === 'GET') return snapshotList(env);
  const snapMatch = path.match(/^\/snapshots\/([0-9-]+)(?:\/(\w+))?$/);
  if (snapMatch) {
    const date = snapMatch[1];
    const action = snapMatch[2];
    if (!action && method === 'GET') return snapshotGet(date, env);
    if (action === 'restore' && method === 'POST') return snapshotRestore(date, env);
  }

  // DB root
  if (path === '/db' && method === 'GET')   return dbGetAll(env);
  if (path === '/db' && method === 'POST')  return dbCreate(request, env);

  // /db/:id o /db/:id/action
  const m = path.match(/^\/db\/([^\/]+)(?:\/(\w+))?$/);
  if (m) {
    const id = m[1];
    const action = m[2];
    if (!action) {
      if (method === 'GET')    return dbGetOne(id, env);
      if (method === 'PATCH')  return dbPatch(id, request, env);
      if (method === 'DELETE') return dbDelete(id, env);
    } else if (method === 'POST') {
      if (action === 'increment') return dbIncrement(id, env);
      if (action === 'decrement') return dbDecrement(id, env);
      if (action === 'markout')   return dbMarkOut(id, env);
      if (action === 'markin')    return dbMarkIn(id, env);
      if (action === 'enrich')    return dbEnqueue(id, env);
    }
  }

  return jsonError('Not found: ' + method + ' ' + path, 404);
}

// ─── Archivio: D1 al posto di KV ─────────────────────────
// KV può restituire per qualche secondo una copia vecchia: con salvataggi ravvicinati
// (Claude che arricchisce 10 vini di fila) un salvataggio cancellava il precedente.
// D1 legge sempre il dato aggiornato. L'archivio espone la stessa interfaccia di KV
// (get/put/list/delete), così il resto del codice non cambia.
// Migrazione senza fermo: finché in D1 manca la chiave MIGRAZIONE_KEY, ciò che D1 non ha
// ancora viene letto da KV (binding KV_VECCHIO), che non viene mai modificato né cancellato.
const MIGRAZIONE_KEY = 'migrazione_kv_completata';

function archivio(env) {
  const d1 = env.ARCHIVIO;
  const kv = env.KV_VECCHIO;
  let migrata;
  const migrazioneCompleta = async () =>
    (migrata ??= !!(await d1.prepare('SELECT 1 FROM kv WHERE chiave = ?').bind(MIGRAZIONE_KEY).first()));
  const riga = chiave => d1.prepare('SELECT valore, versione FROM kv WHERE chiave = ?').bind(chiave).first();

  return {
    async get(chiave) {
      return (await this.getConVersione(chiave)).valore;
    },
    async getConVersione(chiave) {
      const r = await riga(chiave);
      if (r) return { valore: r.valore, versione: r.versione };
      if (kv && !(await migrazioneCompleta())) return { valore: await kv.get(chiave), versione: null };
      return { valore: null, versione: null };
    },
    async put(chiave, valore) {
      await d1.prepare(
        'INSERT INTO kv (chiave, valore, versione) VALUES (?, ?, 1) ' +
        'ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, versione = kv.versione + 1'
      ).bind(chiave, valore).run();
    },
    // Scrive solo se nessun altro ha salvato dopo la nostra lettura (versione = null: chiave non ancora in D1)
    async putSeVersione(chiave, valore, versione) {
      const res = versione == null
        ? await d1.prepare('INSERT INTO kv (chiave, valore, versione) VALUES (?, ?, 1) ON CONFLICT(chiave) DO NOTHING')
            .bind(chiave, valore).run()
        : await d1.prepare('UPDATE kv SET valore = ?, versione = versione + 1 WHERE chiave = ? AND versione = ?')
            .bind(valore, chiave, versione).run();
      return res.meta.changes === 1;
    },
    async list({ prefix = '' } = {}) {
      const { results } = await d1.prepare("SELECT chiave FROM kv WHERE chiave LIKE ? ESCAPE '\\'")
        .bind(prefix.replace(/[%_\\]/g, '\\$&') + '%').all();
      const nomi = new Set(results.map(r => r.chiave));
      if (kv && !(await migrazioneCompleta())) (await kv.list({ prefix })).keys.forEach(k => nomi.add(k.name));
      return { keys: [...nomi].sort().map(name => ({ name })) };
    },
    async delete(chiave) {
      await d1.prepare('DELETE FROM kv WHERE chiave = ?').bind(chiave).run();
    },
  };
}

// Un altro salvataggio è arrivato tra la nostra lettura e la nostra scrittura: si rilegge e si riprova
class ConflittoDB extends Error {}
const versioniLette = new WeakMap();

// ─── Database dei vini ───────────────────────────────────
async function loadDB(env) {
  const { valore, versione } = await env.CANTINA_DB.getConVersione(DB_KEY);
  let db = { wines: [] };
  if (valore) {
    try { db = JSON.parse(valore); } catch (e) { throw new Error('Database illeggibile'); }
  }
  versioniLette.set(db, versione);
  return db;
}

async function saveDB(db, env) {
  db.lastServerUpdate = new Date().toISOString();
  const versione = versioniLette.get(db) ?? null;
  if (!(await env.CANTINA_DB.putSeVersione(DB_KEY, JSON.stringify(db), versione))) {
    throw new ConflittoDB('Il database è cambiato durante il salvataggio');
  }
  versioniLette.set(db, (versione ?? 0) + 1);
  // Prima di salvare, crea snapshot di oggi se non esiste già
  await ensureDailySnapshot(db, env);
  return db;
}

// ─── POST /admin/migra ───────────────────────────────────
// Copia in D1 le chiavi di KV che D1 non ha ancora (non sovrascrive mai) e confronta il contenuto.
// Con ?chiudi=1, se D1 ha tutte le chiavi, segna la migrazione come completata (da lì solo D1).
async function migraDaKV(env, url) {
  const kv = env.KV_VECCHIO;
  if (!kv) return jsonError('KV_VECCHIO non collegato', 500);
  const chiavi = (await kv.list()).keys.map(k => k.name);
  const report = [];
  for (const chiave of chiavi) {
    const valoreKV = await kv.get(chiave);
    const prima = await env.ARCHIVIO.prepare('SELECT valore FROM kv WHERE chiave = ?').bind(chiave).first();
    let azione = 'già in D1';
    if (!prima) {
      await env.ARCHIVIO.prepare('INSERT INTO kv (chiave, valore, versione) VALUES (?, ?, 1) ON CONFLICT(chiave) DO NOTHING')
        .bind(chiave, valoreKV).run();
      azione = 'copiata';
    }
    const dopo = await env.ARCHIVIO.prepare('SELECT valore FROM kv WHERE chiave = ?').bind(chiave).first();
    report.push({ chiave, azione, presente: !!dopo, uguale: dopo?.valore === valoreKV, byte: valoreKV.length });
  }
  const tutteInD1 = report.every(r => r.presente);
  let chiusa = false;
  if (url.searchParams.get('chiudi') === '1' && tutteInD1) {
    await env.CANTINA_DB.put(MIGRAZIONE_KEY, new Date().toISOString());
    chiusa = true;
  }
  return jsonOK({ chiavi: report.length, tutteInD1, chiusa, report });
}

async function ensureDailySnapshot(db, env) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const snapKey = 'snapshot:' + today;
  const existing = await env.CANTINA_DB.get(snapKey);
  if (!existing) {
    // Salva snapshot (prendiamo la versione PRIMA della modifica di oggi)
    // Nota: questo viene chiamato DOPO saveDB, quindi salva la versione aggiornata.
    // In pratica: "lo stato del DB a fine giornata"
    await env.CANTINA_DB.put(snapKey, JSON.stringify({
      date: today,
      savedAt: new Date().toISOString(),
      wines: db.wines,
    }));
    // Cleanup vecchi snapshot
    await cleanupOldSnapshots(env);
  }
}

async function cleanupOldSnapshots(env) {
  const list = await env.CANTINA_DB.list({ prefix: 'snapshot:' });
  const keys = (list.keys || []).map(k => k.name).sort(); // ordinati alfabeticamente = per data
  const toDelete = keys.slice(0, Math.max(0, keys.length - SNAPSHOT_RETENTION_DAYS));
  for (const k of toDelete) {
    await env.CANTINA_DB.delete(k);
  }
}

// ─── GET /snapshots ──────────────────────────────────────
async function snapshotList(env) {
  const list = await env.CANTINA_DB.list({ prefix: 'snapshot:' });
  const dates = (list.keys || [])
    .map(k => k.name.replace(/^snapshot:/, ''))
    .sort((a,b) => b.localeCompare(a)); // più recenti prima
  return jsonOK({ snapshots: dates });
}

// ─── GET /snapshots/:date ────────────────────────────────
async function snapshotGet(date, env) {
  const raw = await env.CANTINA_DB.get('snapshot:' + date);
  if (!raw) return jsonError('Snapshot not found for date ' + date, 404);
  try {
    const snap = JSON.parse(raw);
    return jsonOK(snap);
  } catch (e) {
    return jsonError('Corrupted snapshot', 500);
  }
}

// ─── POST /snapshots/:date/restore ───────────────────────
async function snapshotRestore(date, env) {
  const raw = await env.CANTINA_DB.get('snapshot:' + date);
  if (!raw) return jsonError('Snapshot not found for date ' + date, 404);
  try {
    const snap = JSON.parse(raw);
    const db = { wines: snap.wines, lastServerUpdate: new Date().toISOString(), restoredFrom: date };
    await env.CANTINA_DB.put(DB_KEY, JSON.stringify(db));
    return jsonOK({ restored: true, date, winesCount: snap.wines.length });
  } catch (e) {
    return jsonError('Corrupted snapshot', 500);
  }
}

// ─── GET /consumi ────────────────────────────────────────
// Serie bottiglie/valore dagli snapshot (più lo stato attuale) e date delle bevute registrate.
async function consumi(env) {
  const somma = wines => {
    const stock = (wines || []).filter(w => w.inStock && !w.deletedAt);
    return {
      bottiglie: stock.reduce((s, w) => s + (w.riconteggio || 0), 0),
      valore: Math.round(stock.reduce((s, w) => s + (w.riconteggio || 0) * (w.valore || 0), 0)),
    };
  };
  const list = await env.CANTINA_DB.list({ prefix: 'snapshot:' });
  const date = (list.keys || []).map(k => k.name.slice('snapshot:'.length)).sort();
  const serie = [];
  for (const data of date) {
    try {
      const snap = JSON.parse(await env.CANTINA_DB.get('snapshot:' + data));
      serie.push({ data, ...somma(snap.wines) });
    } catch (e) { /* snapshot illeggibile: saltato */ }
  }
  const db = await loadDB(env);
  serie.push({ data: new Date().toISOString().slice(0, 10), ...somma(db.wines) });

  let registroDal = await env.CANTINA_DB.get('bevute_registrate_dal');
  if (!registroDal) {
    registroDal = new Date().toISOString();
    await env.CANTINA_DB.put('bevute_registrate_dal', registroDal);
  }
  const bevute = db.wines.flatMap(w => w.bevute || []).sort();
  return jsonOK({ serie, bevute, registroDal });
}

// ─── GET /db ─────────────────────────────────────────────
async function dbGetAll(env) { return jsonOK(await loadDB(env)); }

// ─── GET /db/:id ─────────────────────────────────────────
async function dbGetOne(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  return jsonOK(w);
}

// ─── POST /db (crea) ─────────────────────────────────────
async function dbCreate(request, env) {
  let payload;
  try { payload = await request.json(); } catch (e) { return jsonError('Invalid JSON', 400); }
  if (!payload.azienda || !payload.bottiglia) return jsonError('Missing azienda or bottiglia', 400);
  const db = await loadDB(env);
  const newId = 'w_' + Date.now() + '_' + Math.floor(Math.random() * 100000).toString(36);
  const wine = { ...payload, id: newId };
  db.wines.unshift(wine);
  await saveDB(db, env);
  return jsonOK(wine);
}

// ─── PATCH /db/:id ───────────────────────────────────────
async function dbPatch(id, request, env) {
  let updates;
  try { updates = await request.json(); } catch (e) { return jsonError('Invalid JSON', 400); }
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  delete updates.id;
  Object.assign(w, updates);
  await saveDB(db, env);
  return jsonOK(w);
}

// ─── DELETE /db/:id ──────────────────────────────────────
async function dbDelete(id, env) {
  const db = await loadDB(env);
  const idx = db.wines.findIndex(w => String(w.id) === String(id));
  if (idx === -1) return jsonError('Not found', 404);
  const deleted = db.wines[idx];
  db.wines.splice(idx, 1);
  await saveDB(db, env);
  return jsonOK({ deleted: true, id: deleted.id });
}

// ─── Increment / Decrement / MarkOut / MarkIn ────────────
async function dbIncrement(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  w.qtaIniziale = (w.qtaIniziale || 0) + 1;
  w.riconteggio = (w.riconteggio || 0) + 1;
  await saveDB(db, env);
  return jsonOK(w);
}

async function dbDecrement(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  if ((w.riconteggio || 0) > 0) registraBevute(w, 1);
  w.riconteggio = Math.max(0, (w.riconteggio || 0) - 1);
  await saveDB(db, env);
  return jsonOK(w);
}

// Data di ogni bottiglia bevuta, per il ritmo di consumo nelle statistiche
function registraBevute(w, quante) {
  const ora = new Date().toISOString();
  w.bevute = [...(w.bevute || []), ...Array(quante).fill(ora)];
}

async function dbMarkOut(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  // Le bottiglie ancora presenti quando il vino passa nello storico contano come bevute
  if ((w.riconteggio || 0) > 0) registraBevute(w, w.riconteggio);
  w.inStock = false;
  w.riconteggio = 0;
  w.quadrante = '';
  await saveDB(db, env);
  return jsonOK(w);
}

async function dbMarkIn(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  w.inStock = true;
  if ((w.riconteggio || 0) === 0) w.riconteggio = 1;
  await saveDB(db, env);
  return jsonOK(w);
}

// ═══════════════════════════════════════════════════════════
// AI ENDPOINT
// ═══════════════════════════════════════════════════════════
async function handleAI(request, env) {
  let wine;
  try { wine = await request.json(); } catch (e) { return jsonError('Invalid JSON', 400); }
  if (!wine.azienda || !wine.bottiglia) return jsonError('Missing azienda or bottiglia', 400);
  const esito = await arricchisciConAPI(wine, env);
  return esito.error ? jsonError(esito.error, 500) : jsonOK(esito.result);
}

// Chiamata a crediti (Claude Platform). Restituisce { result } oppure { error }.
async function arricchisciConAPI(wine, env) {
  if (!env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY not configured' };

  const prompt = buildPrompt(wine);
  let claudeResponse;
  try {
    const res = await fetch((env.ANTHROPIC_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    });
    claudeResponse = await res.json();
    if (!res.ok) return { error: 'Claude API error: ' + (claudeResponse.error?.message || 'unknown') };
  } catch (e) {
    return { error: 'Network error: ' + e.message };
  }

  const result = extractJSON(claudeResponse);
  if (!result) return { error: 'Could not parse Claude response as JSON' };

  const fw = result.finestraBevuta;
  if (!fw || typeof fw.start !== 'number' || typeof fw.peak !== 'number' || typeof fw.end !== 'number' ||
      fw.start > fw.peak || fw.peak > fw.end) {
    return { error: 'AI returned invalid finestraBevuta' };
  }
  if (!Array.isArray(result.abbinamenti) || result.abbinamenti.length === 0) {
    return { error: 'AI returned invalid abbinamenti' };
  }
  return { result };
}

// ═══════════════════════════════════════════════════════════
// CODA DI ARRICCHIMENTO — prima Claude (abbonamento), poi riserva a crediti
// ═══════════════════════════════════════════════════════════
// Un vino in coda ha aiStato 'coda'. Il timer (ogni 2 minuti):
//  1. se l'ultimo vino è entrato in coda da almeno ATTESA_SECONDI, avvia UNA volta l'attività
//     Claude (routine) per tutti i vini in coda, entro MAX_AVVII_GIORNO avvii al giorno;
//  2. se l'avvio è rifiutato o il tetto è raggiunto, passa subito alla riserva;
//  3. se dopo RISERVA_SECONDI dall'avvio un vino è ancora in coda, passa alla riserva.
// Claude chiude un vino scrivendo aiStato 'claude' dal connettore; la riserva scrive 'riserva'.
// Lo stato degli avvii sta in una chiave a parte (coda_meta) così il timer scrive nel
// database solo quando salva un risultato della riserva.
const META_KEY = 'coda_meta';

const numero = (v, predefinito) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : predefinito);

async function dbEnqueue(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
  Object.assign(w, { aiStato: 'coda', aiCodaDal: new Date().toISOString(), aiErrore: null });
  await saveDB(db, env);
  // Un nuovo inserimento "riapre" l'attesa anche per un vino già avviato in passato
  const meta = await leggiMeta(env);
  delete meta.avviati[String(w.id)];
  await env.CANTINA_DB.put(META_KEY, JSON.stringify(meta));
  return jsonOK(w);
}

async function leggiMeta(env) {
  try {
    const meta = JSON.parse((await env.CANTINA_DB.get(META_KEY)) || '{}');
    return { giorno: '', avvii: 0, avviati: {}, inRiserva: {}, ...meta };
  } catch (e) {
    return { giorno: '', avvii: 0, avviati: {}, inRiserva: {} };
  }
}

async function avviaClaude(env, vini) {
  if (!env.ROUTINE_ID || !env.ROUTINE_TOKEN) return { ok: false, motivo: 'attività Claude non configurata' };
  const elenco = vini.map(w => `- id "${w.id}": ${w.azienda} · ${w.bottiglia}${w.vendemmia ? ' ' + w.vendemmia : ''}`).join('\n');
  try {
    const res = await fetch(
      (env.ROUTINE_FIRE_URL || 'https://api.anthropic.com') + '/v1/claude_code/routines/' + env.ROUTINE_ID + '/fire',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.ROUTINE_TOKEN,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'Vini in coda da arricchire:\n' + elenco }),
      }
    );
    if (!res.ok) return { ok: false, motivo: 'avvio rifiutato: HTTP ' + res.status };
    const data = await res.json().catch(() => ({}));
    return { ok: true, sessione: data.claude_code_session_url || '' };
  } catch (e) {
    return { ok: false, motivo: 'avvio non riuscito: ' + e.message };
  }
}

async function processaCoda(env) {
  const { daRiserva } = await decidiCoda(env);
  await eseguiRiserva(env, daRiserva);
}

// POST /coda/avvia — pulsante "Avvia Claude ora": salta l'attesa per i vini in coda.
// Risponde appena deciso; l'eventuale riserva a crediti prosegue in background.
async function avviaOra(env, ctx) {
  const { esito, daRiserva, inAttesa } = await decidiCoda(env, { subito: true });
  if (daRiserva.length) ctx.waitUntil(eseguiRiserva(env, daRiserva));
  return jsonOK({ esito, inAttesa, riserva: daRiserva.length });
}

// Decide cosa fare dei vini in coda: avviare Claude, passare alla riserva o aspettare.
// Con subito=true non aspetta ATTESA_SECONDI.
async function decidiCoda(env, { subito = false } = {}) {
  const ora = Date.now();
  const attesaMs = numero(env.ATTESA_SECONDI, 300) * 1000;
  const riservaMs = numero(env.RISERVA_SECONDI, 1800) * 1000;
  const maxAvvii = numero(env.MAX_AVVII_GIORNO, 4);

  const db = await loadDB(env);
  const meta = await leggiMeta(env);
  const metaPrima = JSON.stringify(meta);

  // Dimentica avvii e riserve di vini che non sono più in coda (Claude li ha completati)
  const inCoda = new Set(db.wines.filter(w => w.aiStato === 'coda' && !w.deletedAt).map(w => String(w.id)));
  for (const mappa of [meta.avviati, meta.inRiserva]) {
    for (const id of Object.keys(mappa)) if (!inCoda.has(id)) delete mappa[id];
  }
  // Un vino con la riserva ancora in corso (timer precedente) non va ripreso: max 10 minuti
  const coda = db.wines.filter(w => inCoda.has(String(w.id)) &&
    !(meta.inRiserva[String(w.id)] && ora - Date.parse(meta.inRiserva[String(w.id)]) < 10 * 60 * 1000));

  const daRiserva = coda.filter(w => meta.avviati[String(w.id)] && ora - Date.parse(meta.avviati[String(w.id)]) >= riservaMs);
  const nuovi = coda.filter(w => !meta.avviati[String(w.id)]);
  let esito = nuovi.length ? null : { ok: false, motivo: 'nessun vino nuovo in coda' };

  if (nuovi.length) {
    const ultimoIngresso = Math.max(...nuovi.map(w => Date.parse(w.aiCodaDal) || 0));
    if (subito || ora - ultimoIngresso >= attesaMs) {
      const oggi = new Date(ora).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
      if (meta.giorno !== oggi) Object.assign(meta, { giorno: oggi, avvii: 0 });
      esito = meta.avvii < maxAvvii
        ? await avviaClaude(env, nuovi)
        : { ok: false, motivo: `tetto di ${maxAvvii} avvii al giorno raggiunto` };
      meta.ultimoEsito = { quando: new Date(ora).toISOString(), vini: nuovi.length, ...esito };
      if (esito.ok) {
        meta.avvii++;
        for (const w of nuovi) meta.avviati[String(w.id)] = new Date(ora).toISOString();
      } else {
        daRiserva.push(...nuovi);
      }
    }
  }
  for (const w of daRiserva) meta.inRiserva[String(w.id)] = new Date(ora).toISOString();
  // Scrive solo se qualcosa è cambiato: il timer gira ogni 2 minuti e il piano gratuito di KV
  // concede 1.000 scritture al giorno (scrivere sempre ne consumava 720)
  if (JSON.stringify(meta) !== metaPrima) await env.CANTINA_DB.put(META_KEY, JSON.stringify(meta));
  return { esito, daRiserva, inAttesa: coda.length - daRiserva.length };
}

async function eseguiRiserva(env, daRiserva) {
  for (const w of daRiserva) {
    const esito = await arricchisciConAPI(w, env);
    // Ricarico prima di scrivere (nel frattempo Claude o l'app possono aver toccato il vino)
    // e in caso di conflitto rileggo e riprovo
    for (let tentativo = 1; tentativo <= 4; tentativo++) {
      const fresco = await loadDB(env);
      const v = fresco.wines.find(x => String(x.id) === String(w.id));
      if (!v || v.aiStato !== 'coda') break;
      if (esito.error) {
        Object.assign(v, { aiStato: 'errore', aiErrore: esito.error });
      } else {
        const r = esito.result;
        Object.assign(v, {
          finestraBevuta: r.finestraBevuta,
          abbinamenti: r.abbinamenti,
          aiEnriched: true,
          aiLivello: r.livello || 3,
          aiFonte: r.fonte || '',
          aiNote: r.note || '',
          aiTimestamp: new Date().toISOString(),
          aiStato: 'riserva',
          aiErrore: null,
          dwSource: null,
        });
      }
      try {
        await saveDB(fresco, env);
        break;
      } catch (e) {
        if (!(e instanceof ConflittoDB) || tentativo === 4) throw e;
      }
    }
    const m = await leggiMeta(env);
    delete m.avviati[String(w.id)];
    delete m.inRiserva[String(w.id)];
    await env.CANTINA_DB.put(META_KEY, JSON.stringify(m));
  }
}

function buildPrompt(wine) {
  const annata = wine.vendemmia ? `vendemmia ${wine.vendemmia}` : 'senza vendemmia';
  return `Sei un sommelier esperto. Analizza questo vino e fornisci info su finestra di bevuta e abbinamenti.

VINO:
- Produttore: ${wine.azienda}
- Nome: ${wine.bottiglia}
- Annata: ${annata}
- Regione: ${wine.regione || 'N/D'}
- Area/Denominazione: ${wine.area || 'N/D'}
- Marchio: ${wine.etichetta || 'N/D'}
- Tipo: ${wine.tipo || 'N/D'}

STRATEGIA A CASCATA (segui in ordine, IMPORTANTE):

LIVELLO 1 — SPECIFICO: Usa web_search per "${wine.azienda} ${wine.bottiglia} ${wine.vendemmia || ''}". Cerca su siti produttore, guide (Gambero Rosso, Bibenda, Vinous, Wine Spectator, James Suckling), forum wine lovers. Se trovi info SPECIFICHE su QUESTO vino di QUESTA annata → usale. "livello": 1.

LIVELLO 2 — ANNATA+ZONA: Se Livello 1 non dà nulla di specifico, cerca "${wine.area || wine.regione} ${wine.vendemmia || ''} annata" per caratteristiche dell'annata in zona. Combina con caratteristiche tipiche del vitigno. "livello": 2.

LIVELLO 3 — GENERICO: Se anche Livello 2 non dà info utili, usa conoscenze generiche sul vitigno/tipologia. "livello": 3.

REGOLE FERREE:
- Max 3 chiamate web_search.
- Finestra: SEMPRE anni concreti (es. 2024-2030-2042).
- start ≤ peak ≤ end, sempre.
- Abbinamenti: 4-6 piatti SPECIFICI e SINTETICI (max 3 parole). Buoni: "brasato al Barolo", "tartufo bianco". Cattivi: "carni rosse", "cibi saporiti".
- Campo "fonte": siti/guide realmente consultati (max 3, virgola). Livello 3: "Conoscenze generali sul vitigno".
- Campo "note": 1-2 frasi utili (annata, stile produttore, temperatura servizio). Opzionale.

OUTPUT — SOLO questo JSON, niente testo prima o dopo:
{
  "livello": 1|2|3,
  "fonte": "fonti consultate",
  "finestraBevuta": {"start": ANNO, "peak": ANNO, "end": ANNO},
  "abbinamenti": ["piatto1", "piatto2", "piatto3", "piatto4"],
  "note": "stringa opzionale"
}`;
}

function extractJSON(response) {
  if (!response || !response.content || !Array.isArray(response.content)) return null;
  const textBlocks = response.content.filter(b => b.type === 'text');
  if (textBlocks.length === 0) return null;
  const lastText = textBlocks[textBlocks.length - 1].text;
  const match = lastText.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (!obj.finestraBevuta || !obj.abbinamenti) return null;
    return obj;
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════
// HTTP helpers
// ═══════════════════════════════════════════════════════════
function jsonOK(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}