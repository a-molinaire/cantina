// Prova end-to-end del connettore in locale, come farebbe Claude:
// scoperta OAuth → registrazione client → consenso con token → scambio codice → strumenti MCP.
// Uso: node test/flusso.mjs   (con "worker locale" su :8787 e "connettore locale" su :8788)
//      node test/flusso.mjs --produzione   (connettore vero, token da ../.env, solo lettura)
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const PROD = process.argv.includes('--produzione');
const BASE = PROD ? 'https://cantina-mcp.molinaire.workers.dev' : 'http://localhost:8788';
const TOKEN = readFileSync(new URL(PROD ? '../../.env' : '../.dev.vars', import.meta.url), 'utf8').match(/CANTINA_TOKEN=(.+)/)[1].trim();
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ok = (cond, msg) => { if (!cond) throw new Error('FALLITO: ' + msg); console.log('✓', msg); };

// 1. Senza token: 401 con il puntatore ai metadati
let res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok(res.status === 401 && /resource_metadata=/.test(res.headers.get('WWW-Authenticate') || ''), '/mcp senza token risponde 401 con resource_metadata');
const metaUrl = res.headers.get('WWW-Authenticate').match(/resource_metadata="([^"]+)"/)[1];
const prm = await (await fetch(metaUrl)).json();
ok(prm.resource === BASE + '/mcp', 'metadati della risorsa corretti');
const as = await (await fetch(prm.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json();
ok(as.registration_endpoint && as.code_challenge_methods_supported.includes('S256'), 'metadati OAuth con registrazione e PKCE S256');
console.log('  CIMD supportato:', as.client_id_metadata_document_supported, '| auth metodi:', as.token_endpoint_auth_methods_supported);

// 2. Registrazione dinamica del client (come fa Claude)
const client = await (await fetch(as.registration_endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude (prova)', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
})).json();
ok(client.client_id, 'client registrato');

// 3. Pagina di consenso
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authUrl = new URL(as.authorization_endpoint);
Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te', scope: 'cantina offline_access', resource: BASE + '/mcp' })
  .forEach(([k, v]) => authUrl.searchParams.set(k, v));
res = await fetch(authUrl);
const html = await res.text();
const cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
ok(res.status === 200 && handle && html.includes('Token della cantina'), 'pagina di consenso con campo token');
ok(res.headers.get('X-Frame-Options') === 'DENY', 'pagina protetta dal framing');
// Senza l'origine di Claude in form-action il browser blocca il rimando dopo "Consenti"
ok((res.headers.get('Content-Security-Policy') || '').includes('form-action \x27self\x27 https://claude.ai'), 'il modulo può rimandare a claude.ai');

const post = (fields) => fetch(authUrl, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams({ handle, ...fields }) });
res = await post({ token: 'sbagliato', decision: 'approve' });
ok(res.status === 401 && (await res.text()).includes('Token non valido'), 'token sbagliato rifiutato, pagina ripresentata');
res = await post({ token: TOKEN, decision: 'approve' });
const loc = res.headers.get('Location') || '';
ok(res.status === 302 && loc.startsWith(REDIRECT) && new URL(loc).searchParams.get('state') === 'st4te', 'token giusto: rimanda a Claude con il codice');
const code = new URL(loc).searchParams.get('code');

// 4. Scambio del codice (form-urlencoded, come Claude)
const tok = await (await fetch(as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: BASE + '/mcp' }) })).json();
ok(tok.access_token && tok.refresh_token, 'access token e refresh token ottenuti (scope: ' + tok.scope + ')');

// 5. Strumenti MCP
let id = 0;
async function rpc(method, params) {
  const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + tok.access_token, 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const text = await r.text();
  const body = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').filter(l => l.startsWith('data:')).pop().slice(5));
  if (body.error) throw new Error(method + ': ' + JSON.stringify(body.error));
  return body.result;
}
const tool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(name + ': ' + r.content[0].text);
  return JSON.parse(r.content[0].text);
};

const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prova', version: '1' } });
ok(init.serverInfo.name === 'Cantina Molinaro', 'initialize: ' + init.serverInfo.name + ' (protocollo ' + init.protocolVersion + ')');
const { tools } = await rpc('tools/list', {});
ok(tools.length === 6, 'strumenti: ' + tools.map(t => t.name).join(', '));

const pan = await tool('panoramica_cantina');
ok(pan.bottiglie > 0 && pan.etichette > 0, `panoramica: ${pan.bottiglie} bottiglie, ${pan.etichette} etichette, ${pan.valore_euro} €`);
console.log('  per stato:', JSON.stringify(pan.per_stato), '| da bere presto:', pan.da_bere_presto.length);

if (PROD) {
  const r = await tool('cerca_vini', { stati: ['apice'], limite: 3 });
  console.log("  all'apice:", r.trovati, '| es.', r.vini.map(v => v.vino + ' ' + v.vendemmia).join('; '));
  console.log('\nTutto ok in produzione (solo lettura, nessuna modifica alla cantina).');
  process.exit(0);
}
const apice = await tool('cerca_vini', { stati: ['apice', 'pronto'], tipo: 'Rosso' });
console.log('  rossi pronti/apice:', apice.trovati, '| es.', apice.vini.slice(0, 2).map(v => v.vino + ' ' + v.vendemmia).join('; '));
const brasato = await tool('cerca_vini', { testo: 'brasato' });
ok(brasato.trovati > 0, `ricerca "brasato": ${brasato.trovati} vini`);
const storico = await tool('cerca_vini', { dove: 'storico', limite: 3 });
ok(storico.trovati > 0, `storico: ${storico.trovati} vini bevuti`);

const NOME = 'Rosso di Test ' + Date.now(); // nome unico: la prova si può ripetere
const nuovo = await tool('aggiungi_vino', { azienda: 'Prova Connettore', bottiglia: NOME, vendemmia: 2020, tipo: 'Rosso', regione: 'Toscana', bottiglie: 2, valore: 20, finestraBevuta: { start: 2023, peak: 2026, end: 2030 }, abbinamenti: ['arrosti', 'formaggi'], fonti: 'test' });
ok(nuovo.esito === 'nuovo vino aggiunto' && nuovo.vino.bottiglie === 2 && nuovo.vino.stato === 'apice', 'aggiungi_vino crea un vino nuovo');
const merge = await tool('aggiungi_vino', { azienda: 'prova connettore', bottiglia: NOME.toLowerCase(), vendemmia: 2020 });
ok(merge.vino.id === nuovo.vino.id && merge.vino.bottiglie === 3, 'stesso vino: unisce le bottiglie (3)');
const mod = await tool('modifica_vino', { id: nuovo.vino.id, quadrante: 'Dx9' });
ok(mod.vino.posizione === 'Dx9', 'modifica_vino aggiorna la posizione');
await tool('bevi_bottiglia', { id: nuovo.vino.id, nota: 'voto 8, buono' });
await tool('bevi_bottiglia', { id: nuovo.vino.id });
const ultima = await tool('bevi_bottiglia', { id: nuovo.vino.id });
ok(ultima.vino.in_cantina === false && /voto 8/.test(ultima.vino.note), "ultima bottiglia: passa nello storico con la nota");
const det = await tool('dettaglio_vino', { id: nuovo.vino.id });
ok(det.aiEnriched === true && det.finestraBevuta.peak === 2026, 'dettaglio: finestra salvata nel formato dell\'app');

// 6. Rinnovo del token
const ref = await (await fetch(as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id }) })).json();
ok(ref.access_token && ref.refresh_token && ref.refresh_token !== tok.refresh_token, 'refresh: nuovo token e refresh ruotato');

console.log('\nTutto ok. Il vino di prova resta solo nel Worker locale di prova (id ' + nuovo.vino.id + ').');
