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
// POST   /ai                    → arricchimento AI
// GET    /snapshots             → lista date snapshot
// GET    /snapshots/:date       → scarica snapshot
// POST   /snapshots/:date/restore → ripristina snapshot
// 
// Tutti richiedono Authorization: Bearer <CANTINA_TOKEN>
// ═══════════════════════════════════════════════════════════

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1200;
const TEMPERATURE = 0;
const DB_KEY = 'db';
const SNAPSHOT_RETENTION_DAYS = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
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
      }
    }

    return jsonError('Not found: ' + method + ' ' + path, 404);
  },
};

// ─── KV helpers ──────────────────────────────────────────
async function loadDB(env) {
  if (!env.CANTINA_DB) throw new Error('CANTINA_DB KV not bound');
  const raw = await env.CANTINA_DB.get(DB_KEY);
  if (!raw) return { wines: [] };
  try { return JSON.parse(raw); } catch (e) { return { wines: [] }; }
}

async function saveDB(db, env) {
  db.lastServerUpdate = new Date().toISOString();
  await env.CANTINA_DB.put(DB_KEY, JSON.stringify(db));
  // Prima di salvare, crea snapshot di oggi se non esiste già
  await ensureDailySnapshot(db, env);
  return db;
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
  w.riconteggio = Math.max(0, (w.riconteggio || 0) - 1);
  await saveDB(db, env);
  return jsonOK(w);
}

async function dbMarkOut(id, env) {
  const db = await loadDB(env);
  const w = db.wines.find(w => String(w.id) === String(id));
  if (!w) return jsonError('Not found', 404);
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
  if (!env.ANTHROPIC_API_KEY) return jsonError('ANTHROPIC_API_KEY not configured', 500);

  const prompt = buildPrompt(wine);
  let claudeResponse;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
    });
    claudeResponse = await res.json();
    if (!res.ok) return jsonError('Claude API error: ' + (claudeResponse.error?.message || 'unknown'), 500);
  } catch (e) {
    return jsonError('Network error: ' + e.message, 500);
  }

  const result = extractJSON(claudeResponse);
  if (!result) return jsonError('Could not parse Claude response as JSON', 500);

  const fw = result.finestraBevuta;
  if (!fw || typeof fw.start !== 'number' || typeof fw.peak !== 'number' || typeof fw.end !== 'number' ||
      fw.start > fw.peak || fw.peak > fw.end) {
    return jsonError('AI returned invalid finestraBevuta', 500);
  }
  if (!Array.isArray(result.abbinamenti) || result.abbinamenti.length === 0) {
    return jsonError('AI returned invalid abbinamenti', 500);
  }
  return jsonOK(result);
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