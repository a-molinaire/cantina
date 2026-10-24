// Client verso il Worker cantina-ai (l'API già usata dall'app).
// In produzione passa dal service binding CANTINA_API; in locale da API_URL.
import { env } from 'cloudflare:workers';

export interface Finestra {
  start: number;
  peak: number;
  end: number;
}

export interface Wine {
  id: string;
  azienda: string;
  bottiglia: string;
  regione?: string;
  area?: string;
  etichetta?: string;
  vendemmia?: number | null;
  tipo?: string;
  valore?: number;
  quadrante?: string;
  noteAcquisto?: string;
  utilizzo?: string;
  qtaIniziale?: number;
  riconteggio?: number;
  conservazione?: string;
  inStock?: boolean;
  finestraBevuta?: Finestra | null;
  abbinamenti?: string[] | null;
  aiEnriched?: boolean;
  aiLivello?: number;
  aiFonte?: string;
  aiNote?: string;
  aiTimestamp?: string;
  deletedAt?: string;
  [key: string]: unknown;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + env.CANTINA_TOKEN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  const res = env.CANTINA_API
    ? await env.CANTINA_API.fetch('https://cantina-ai' + path, init)
    : await fetch(env.API_URL + path, init);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`API cantina ${method} ${path}: ${err.error || 'HTTP ' + res.status}`);
  }
  return res.json() as Promise<T>;
}

// I vini con deletedAt sono cancellati: l'app li nasconde, qui pure.
export async function getWines(): Promise<Wine[]> {
  const data = await call<{ wines: Wine[] }>('GET', '/db');
  return (data.wines || []).filter(w => !w.deletedAt);
}

export const getWine = (id: string) => call<Wine>('GET', '/db/' + encodeURIComponent(id));
export const createWine = (wine: Partial<Wine>) => call<Wine>('POST', '/db', wine);
export const patchWine = (id: string, updates: Partial<Wine>) =>
  call<Wine>('PATCH', '/db/' + encodeURIComponent(id), updates);
export const markOut = (id: string) => call<Wine>('POST', '/db/' + encodeURIComponent(id) + '/markout');
