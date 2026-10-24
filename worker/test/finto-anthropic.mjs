// Finto servizio Anthropic per le prove in locale della coda di arricchimento.
// - POST /v1/claude_code/routines/:id/fire  → avvio dell'attività Claude (ok, oppure rifiuto 429)
// - POST /v1/messages                        → riserva a crediti (risposta JSON valida, oppure errore 500)
// - POST /_modo {fire, messages}             → sceglie il comportamento
// - GET  /_stato                             → chiamate ricevute
// Uso: node test/finto-anthropic.mjs   (porta 8790)
import { createServer } from 'node:http';

const modo = { fire: 'ok', messages: 'ok' };
const stato = { fire: [], messages: [] };

const leggi = req => new Promise(r => { let s = ''; req.on('data', d => (s += d)); req.on('end', () => r(s)); });
const invia = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  const body = await leggi(req);
  if (req.url === '/_modo' && req.method === 'POST') { Object.assign(modo, JSON.parse(body)); return invia(res, 200, modo); }
  if (req.url === '/_stato') return invia(res, 200, { modo, ...stato });
  if (req.url === '/_azzera' && req.method === 'POST') { stato.fire = []; stato.messages = []; return invia(res, 200, {}); }

  if (/\/v1\/claude_code\/routines\/[^/]+\/fire$/.test(req.url)) {
    stato.fire.push({ auth: req.headers.authorization, version: req.headers['anthropic-version'], text: JSON.parse(body || '{}').text });
    if (modo.fire !== 'ok') return invia(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'limite' } });
    return invia(res, 200, { type: 'routine_fire', claude_code_session_id: 'session_prova', claude_code_session_url: 'https://claude.ai/code/session_prova' });
  }

  if (req.url === '/v1/messages') {
    const richiesta = JSON.parse(body);
    stato.messages.push({ model: richiesta.model, auth: req.headers['x-api-key'] });
    if (modo.messages !== 'ok') return invia(res, 500, { type: 'error', error: { type: 'api_error', message: 'errore finto' } });
    const risultato = { livello: 2, fonte: 'fonte finta', finestraBevuta: { start: 2025, peak: 2028, end: 2033 }, abbinamenti: ['risotto', 'arrosto'], note: 'nota finta' };
    return invia(res, 200, { content: [{ type: 'text', text: JSON.stringify(risultato) }] });
  }

  invia(res, 404, { error: 'non previsto: ' + req.url });
}).listen(8790, () => console.log('finto Anthropic su http://localhost:8790'));
