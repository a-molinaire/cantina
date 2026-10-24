// Connettore MCP della cantina per Claude (claude.ai, app desktop e mobile).
// - /mcp: gli strumenti (tools.ts), accessibili solo con un token OAuth valido
// - /authorize: pagina dove si autorizza Claude inserendo il token della cantina
// Il resto (registrazione client, token, metadati OAuth) lo gestisce OAuthProvider.
import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { createServer } from './tools';

const DAY = 60 * 60 * 24;
const MAX_TENTATIVI = 10; // token sbagliati per IP ogni 15 minuti

const mcpHandler = createMcpHandler(createServer);

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// form-action deve includere anche l'origine di ritorno del client: i browser applicano
// la regola pure al redirect 302 che segue l'invio del modulo, e senza di essa il rimando
// a Claude viene bloccato in silenzio.
const sicurezza = (redirectUri: string) => ({
  'Content-Type': 'text/html; charset=utf-8',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'`,
  'Referrer-Policy': 'no-referrer',
});

function paginaConsenso(details: ConsentDescription, handle: string, errore = ''): string {
  const nome = escape(details.clientName);
  const origine = details.clientDomain
    ? `Pubblicata da <strong>${escape(details.clientDomain)}</strong>.`
    : 'Si è registrata da sola: il nome non è verificato.';
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Collega ${nome} alla cantina</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box;
         background: #0F0D0B; color: #F0E8D8; font: 15px/1.5 -apple-system, "Segoe UI", sans-serif; }
  .box { background: #181512; border: 1px solid #3a322b; border-radius: 16px; padding: 28px; max-width: 400px; width: 100%; }
  h1 { font: 400 24px Georgia, serif; color: #C4455E; margin: 0 0 4px; }
  h1 span { color: #E2BF7A; }
  p { color: #C9BCA8; font-size: 14px; }
  .warn { color: #E2BF7A; }
  label { display: block; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #8a7d6c; margin: 18px 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 11px 14px; border-radius: 8px; border: 1px solid #3a322b; background: #221d18; color: #F0E8D8; font-size: 15px; }
  .err { background: rgba(224,112,112,.12); border: 1px solid rgba(224,112,112,.3); color: #e07070; padding: 10px; border-radius: 8px; font-size: 13px; margin-top: 14px; }
  .btns { display: flex; flex-direction: row-reverse; gap: 10px; margin-top: 20px; }
  button { flex: 1; padding: 12px; border-radius: 10px; border: 0; font-size: 14px; font-weight: 600; cursor: pointer; }
  .ok { background: #C4455E; color: #fff; }
  .no { background: transparent; color: #C9BCA8; border: 1px solid #3a322b; }
</style></head>
<body><form class="box" method="post">
  <h1>Cantina Molinaro<span>.</span></h1>
  <p><strong>${nome}</strong> chiede di leggere e modificare la tua cantina. ${origine}
  L'accesso verrà inviato a <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn">Accesso verso un\'app su questo computer: continua solo se l\'hai appena avviata tu.</p>' : ''}
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="token">Token della cantina</label>
  <input id="token" name="token" type="password" autocomplete="current-password" autofocus>
  ${errore ? `<div class="err">${escape(errore)}</div>` : ''}
  <div class="btns">
    <!-- Consenti per primo: è il pulsante che parte premendo Invio nel campo token -->
    <button class="ok" name="decision" value="approve">Consenti</button>
    <button class="no" name="decision" value="deny">Nega</button>
  </div>
</form></body></html>`;
}

async function tokenCorretto(inserito: string, atteso: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(inserito)),
    crypto.subtle.digest('SHA-256', enc.encode(atteso)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });
    const oauth = env.OAUTH_PROVIDER;

    try {
      if (request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        for (const [k, v] of Object.entries(sicurezza(details.redirectUri))) consent.headers.set(k, v);
        return new Response(paginaConsenso(details, consent.handle), { headers: consent.headers });
      }

      if (request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle') || '');

        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }

        const ip = request.headers.get('CF-Connecting-IP') || 'locale';
        const chiave = 'tentativi:' + ip;
        const tentativi = Number((await env.OAUTH_KV.get(chiave)) || 0);
        if (tentativi >= MAX_TENTATIVI) {
          return new Response('Troppi tentativi. Riprova tra 15 minuti.', { status: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }

        if (!env.CANTINA_TOKEN) throw new Error('CANTINA_TOKEN non configurato');
        if (!(await tokenCorretto(String(form.get('token') || '').trim(), env.CANTINA_TOKEN))) {
          await env.OAUTH_KV.put(chiave, String(tentativi + 1), { expirationTtl: 15 * 60 });
          // La richiesta di autorizzazione è ancora valida: ripresento la pagina con lo stesso handle
          const authRequest = await oauth.parseAuthRequest(new Request(request.url, { headers: request.headers }));
          const details = await oauth.describeConsent(authRequest);
          return new Response(paginaConsenso(details, handle, 'Token non valido.'), { status: 401, headers: sicurezza(details.redirectUri) });
        }

        const approved = await oauth.approveConsent(request, handle);
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: 'cantina',
          metadata: { label: 'Cantina Molinaro' },
          scope: approved.request.scope,
          props: { userId: 'cantina' },
        });
        approved.headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }

      return new Response('Method not allowed', { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const msg = error instanceof AuthorizationError ? error.description : "Impossibile verificare l'app che chiede l'accesso.";
        return new Response(escape(msg || 'Richiesta non valida.') + '\n\nTorna su Claude e riprova a collegare il connettore.', {
          status: 400,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      throw error;
    }
  },
};

// Costruito alla prima richiesta perché l'indirizzo pubblico arriva da env
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    provider ??= new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: { fetch: (req: Request, e: Env, c: ExecutionContext) => mcpHandler(req, e, c) },
      defaultHandler: authHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ['cantina', 'offline_access'],
      requiredScopes: ['cantina'],
      resourceMetadata: {
        resource: env.PUBLIC_URL + '/mcp',
        authorization_servers: [env.PUBLIC_URL],
      },
      accessTokenTTL: 60 * 60,
      refreshTokenTTL: 90 * DAY,
      refreshTokenIdleTTL: 90 * DAY, // resta collegato finché lo usi almeno ogni 3 mesi
      clientRegistrationTTL: 365 * DAY,
    });
    return provider.fetch(request, env, ctx);
  },
};
