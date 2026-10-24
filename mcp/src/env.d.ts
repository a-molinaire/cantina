// Binding e variabili del Worker cantina-mcp (vedi wrangler.jsonc)
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

declare global {
  interface Env {
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: OAuthHelpers;
    CANTINA_TOKEN: string;
    PUBLIC_URL: string;
    CANTINA_API?: Fetcher; // produzione: service binding verso cantina-ai
    API_URL?: string; // prove in locale
  }
}

declare module 'cloudflare:workers' {
  interface Env extends globalThis.Env {}
}

export {};
