// Strumenti MCP della cantina: quello che Claude può leggere e fare.
// Le regole (stato di maturità, unione di vini identici, bottiglia finita → storico)
// replicano quelle dell'app, così app e Claude si comportano allo stesso modo.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createWine, decrement, getWine, getWines, markOut, patchWine, type Finestra, type Wine } from './api';

const TIPI = ['Rosso', 'Bianco', 'Bianco Spumante', 'Rosè', 'Rose Spumante'] as const;
const STATI = ['giovane', 'pronto', 'apice', 'maturo', 'vecchio', 'sconosciuto'] as const;
type Stato = (typeof STATI)[number];

// Stessa logica di getDWStatus() nell'app
function stato(fw: Finestra | null | undefined, anno = new Date().getFullYear()): Stato {
  if (!fw) return 'sconosciuto';
  if (anno < fw.start) return 'giovane';
  if (anno < fw.peak - 1) return 'pronto';
  if (anno <= fw.peak + 1) return 'apice';
  if (anno <= fw.end) return 'maturo';
  return 'vecchio';
}

function finestraValida(fw: Finestra): boolean {
  return fw.start >= 1900 && fw.end <= 2100 && fw.start <= fw.peak && fw.peak <= fw.end;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// Stessa logica di winesMatch() nell'app
const stessoVino = (a: Partial<Wine>, b: Partial<Wine>) =>
  norm(a.azienda) === norm(b.azienda) &&
  norm(a.bottiglia) === norm(b.bottiglia) &&
  (a.vendemmia || null) === (b.vendemmia || null) &&
  norm(a.etichetta) === norm(b.etichetta);

// Riga compatta per elenchi: tutto quello che serve per scegliere una bottiglia
function riga(w: Wine) {
  return {
    id: w.id,
    vino: [w.azienda, w.bottiglia, w.etichetta].filter(Boolean).join(' · '),
    vendemmia: w.vendemmia ?? null,
    tipo: w.tipo,
    zona: [w.regione, w.area].filter(Boolean).join(' / '),
    bottiglie: w.inStock ? (w.riconteggio ?? 0) : 0,
    valore_euro: w.valore || 0,
    posizione: w.quadrante || '',
    finestra: w.finestraBevuta ? `${w.finestraBevuta.start}-${w.finestraBevuta.peak}-${w.finestraBevuta.end}` : null,
    stato: stato(w.finestraBevuta),
    abbinamenti: w.abbinamenti || [],
    note: w.utilizzo || '',
    in_cantina: !!w.inStock,
  };
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const errore = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const finestraSchema = z
  .object({
    start: z.number().int().describe('Anno da cui è pronto da bere'),
    peak: z.number().int().describe('Anno di apice'),
    end: z.number().int().describe('Anno oltre il quale declina'),
  })
  .describe('Finestra di bevuta in anni solari, con start ≤ peak ≤ end');

const campiVino = {
  regione: z.string().optional(),
  area: z.string().optional().describe('Zona o denominazione geografica, es. "Valpolicella", "Langhe"'),
  etichetta: z.string().optional().describe('Classificazione: DOCG, DOC, IGT, Riserva…'),
  vendemmia: z.number().int().optional(),
  tipo: z.enum(TIPI).optional(),
  valore: z.number().optional().describe('Valore o prezzo di una bottiglia, in euro'),
  quadrante: z.string().optional().describe('Posizione in cantina, es. "Dx1", "Sx4"'),
  conservazione: z.enum(['Conservato in cantina', 'Conservato in casa']).optional(),
  noteAcquisto: z.string().optional().describe('Dove, quando, da chi è stato comprato'),
  utilizzo: z.string().optional().describe('Caratteristiche e profilo, note di degustazione'),
  finestraBevuta: finestraSchema.optional(),
  abbinamenti: z.array(z.string()).optional().describe('3-6 abbinamenti gastronomici in italiano'),
  noteAI: z.string().optional().describe('Breve scheda: annata, stile, temperatura di servizio'),
  fonti: z.string().optional().describe('Fonti consultate per finestra e abbinamenti'),
  livello: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe(
      'Affidabilità della finestra: 1 = fonti specifiche su questo vino e annata, ' +
        '2 = dati di annata/denominazione o vini analoghi, 3 = stima generica sul vitigno'
    ),
};

// Converte i campi "parlanti" dello strumento nei campi del database dell'app.
// Una finestra di bevuta scritta da Claude chiude anche l'eventuale attesa in coda.
function versoDB(input: Record<string, unknown>): Partial<Wine> {
  const { noteAI, fonti, finestraBevuta, livello, ...resto } = input as {
    noteAI?: string;
    fonti?: string;
    finestraBevuta?: Finestra;
    livello?: number;
  } & Partial<Wine>;
  const out: Partial<Wine> = { ...resto };
  if (finestraBevuta) {
    out.finestraBevuta = finestraBevuta;
    out.aiEnriched = true;
    out.aiLivello = livello ?? (fonti ? 2 : 3);
    out.aiFonte = fonti || 'Claude';
    out.aiTimestamp = new Date().toISOString();
    out.aiStato = 'claude';
    out.aiCodaDal = null;
    out.aiErrore = null;
    out.dwSource = null;
  }
  if (noteAI !== undefined) out.aiNote = noteAI;
  return out;
}

export function createServer() {
  const server = new McpServer({ name: 'Cantina Molinaro', version: '1.0.0' });

  server.registerTool(
    'panoramica_cantina',
    {
      title: 'Panoramica della cantina',
      description:
        'Riepilogo della cantina: bottiglie, valore, distribuzione per tipo e regione, quante sono giovani, pronte, ' +
        "all'apice, mature o vecchie, e l'elenco dei vini da bere presto (maturi o oltre la finestra).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const wines = await getWines();
      const inCantina = wines.filter(w => w.inStock);
      const bottiglie = (w: Wine) => w.riconteggio || 0;
      const conta = (chiave: (w: Wine) => string) =>
        inCantina.reduce<Record<string, number>>((acc, w) => {
          const k = chiave(w) || '—';
          acc[k] = (acc[k] || 0) + bottiglie(w);
          return acc;
        }, {});
      return json({
        anno: new Date().getFullYear(),
        bottiglie: inCantina.reduce((s, w) => s + bottiglie(w), 0),
        etichette: inCantina.length,
        valore_euro: Math.round(inCantina.reduce((s, w) => s + bottiglie(w) * (w.valore || 0), 0)),
        per_stato: conta(w => stato(w.finestraBevuta)),
        per_tipo: conta(w => w.tipo || ''),
        per_regione: conta(w => w.regione || ''),
        bevute_in_storico: wines.filter(w => !w.inStock).length,
        da_bere_presto: inCantina
          .filter(w => ['maturo', 'vecchio'].includes(stato(w.finestraBevuta)))
          .sort((a, b) => (a.finestraBevuta?.end ?? 0) - (b.finestraBevuta?.end ?? 0))
          .map(riga),
      });
    }
  );

  server.registerTool(
    'cerca_vini',
    {
      title: 'Cerca vini',
      description:
        'Cerca tra i vini. Senza filtri restituisce tutta la cantina attuale. Usalo per "cosa apro stasera": ' +
        'filtra per stato (pronto, apice, maturo) e scegli guardando abbinamenti, tipo e valore. ' +
        "Il testo cerca in produttore, nome, zona, classificazione, abbinamenti e note. " +
        'Con dove="storico" mostra le bottiglie già bevute.',
      inputSchema: z.object({
        testo: z.string().optional().describe('Parole da cercare, es. "barolo", "brasato", "Quintarelli"'),
        tipo: z.enum(TIPI).optional(),
        regione: z.string().optional(),
        stati: z.array(z.enum(STATI)).optional().describe('Stati di maturità da includere'),
        dove: z.enum(['cantina', 'storico', 'tutti']).optional().describe('Predefinito: cantina'),
        limite: z.number().int().min(1).max(200).optional().describe('Predefinito: 100'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ testo, tipo, regione, stati, dove = 'cantina', limite = 100 }) => {
      const parole = norm(testo).split(/\s+/).filter(Boolean);
      const risultati = (await getWines())
        .filter(w => (dove === 'tutti' ? true : dove === 'storico' ? !w.inStock : w.inStock))
        .filter(w => !tipo || w.tipo === tipo)
        .filter(w => !regione || norm(w.regione) === norm(regione))
        .filter(w => !stati?.length || stati.includes(stato(w.finestraBevuta)))
        .filter(w => {
          if (!parole.length) return true;
          const testoVino = norm(
            [w.azienda, w.bottiglia, w.regione, w.area, w.etichetta, w.tipo, w.utilizzo, w.aiNote, ...(w.abbinamenti || [])].join(' ')
          );
          return parole.every(p => testoVino.includes(p));
        });
      return json({ trovati: risultati.length, vini: risultati.slice(0, limite).map(riga) });
    }
  );

  server.registerTool(
    'vini_da_arricchire',
    {
      title: 'Vini da arricchire',
      description:
        "Vini in coda per l'arricchimento (finestra di bevuta, abbinamenti, scheda), con i dati utili alla ricerca. " +
        'Per ciascuno cerca sul web come un sommelier e salva con modifica_vino passando finestraBevuta, abbinamenti, ' +
        'noteAI, fonti e livello: così il vino esce dalla coda. Con anche_senza_finestra=true elenca anche i vini ' +
        'che non hanno mai avuto una finestra di bevuta.',
      inputSchema: z.object({
        anche_senza_finestra: z.boolean().optional().describe('Predefinito: false'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ anche_senza_finestra = false }) => {
      const vini = (await getWines()).filter(
        w => w.aiStato === 'coda' || w.aiStato === 'errore' || (anche_senza_finestra && !w.finestraBevuta)
      );
      return json({
        anno: new Date().getFullYear(),
        da_arricchire: vini.length,
        vini: vini.map(w => ({
          id: w.id,
          azienda: w.azienda,
          bottiglia: w.bottiglia,
          vendemmia: w.vendemmia ?? null,
          tipo: w.tipo,
          regione: w.regione || '',
          area: w.area || '',
          etichetta: w.etichetta || '',
          note: w.utilizzo || '',
          in_coda_dal: w.aiCodaDal || null,
          errore_precedente: w.aiErrore || null,
        })),
      });
    }
  );

  server.registerTool(
    'dettaglio_vino',
    {
      title: 'Dettaglio di un vino',
      description: 'Scheda completa di un vino: note di acquisto, scheda AI, fonti, quantità iniziale.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const w = await getWine(id);
      return json({ ...w, stato: stato(w.finestraBevuta) });
    }
  );

  server.registerTool(
    'aggiungi_vino',
    {
      title: 'Aggiungi vino',
      description:
        "Aggiunge bottiglie in cantina. Se lo stesso vino (produttore, nome, annata, classificazione) c'è già, " +
        'aumenta le bottiglie; se è nello storico lo rimette in cantina. ' +
        "Quando l'utente manda la foto di un'etichetta, leggi dall'immagine produttore, nome, annata, " +
        'zona e classificazione. Prima di salvare un vino nuovo, se puoi cerca sul web finestra di bevuta e ' +
        'abbinamenti (come farebbe un sommelier) e passali insieme alle fonti. Se mancano dati importanti, chiedili.',
      inputSchema: z.object({
        azienda: z.string().describe('Produttore'),
        bottiglia: z.string().describe('Nome del vino'),
        bottiglie: z.number().int().min(1).optional().describe('Quante bottiglie aggiungere (predefinito 1)'),
        ...campiVino,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bottiglie: qta = 1, ...input }) => {
      if (input.finestraBevuta && !finestraValida(input.finestraBevuta)) {
        return errore('Finestra di bevuta non valida: serve start ≤ peak ≤ end, anni tra 1900 e 2100.');
      }
      const dati = versoDB(input);
      const esistente = (await getWines()).find(w => stessoVino(w, dati));

      if (esistente?.inStock) {
        const patch: Partial<Wine> = {
          qtaIniziale: (esistente.qtaIniziale || 0) + qta,
          riconteggio: (esistente.riconteggio || 0) + qta,
        };
        if (dati.quadrante) patch.quadrante = dati.quadrante;
        if (dati.valore && !esistente.valore) patch.valore = dati.valore;
        if (dati.noteAcquisto) {
          patch.noteAcquisto = esistente.noteAcquisto ? esistente.noteAcquisto + ' | ' + dati.noteAcquisto : dati.noteAcquisto;
        }
        const w = await patchWine(esistente.id, patch);
        return json({ esito: 'aggiunte bottiglie a un vino già in cantina', vino: riga(w) });
      }

      if (esistente) {
        const patch: Partial<Wine> = {
          inStock: true,
          qtaIniziale: (esistente.qtaIniziale || 0) + qta,
          riconteggio: qta,
          quadrante: dati.quadrante || '',
        };
        if (dati.valore) patch.valore = dati.valore;
        if (dati.noteAcquisto) {
          patch.noteAcquisto = esistente.noteAcquisto ? esistente.noteAcquisto + ' | ' + dati.noteAcquisto : dati.noteAcquisto;
        }
        if (dati.finestraBevuta) {
          Object.assign(patch, versoDB({ finestraBevuta: dati.finestraBevuta, fonti: input.fonti, livello: input.livello }));
        }
        if (dati.abbinamenti) patch.abbinamenti = dati.abbinamenti;
        const w = await patchWine(esistente.id, patch);
        return json({ esito: 'vino rimesso in cantina dallo storico', vino: riga(w) });
      }

      const w = await createWine({
        regione: '',
        area: '',
        etichetta: '',
        vendemmia: null,
        tipo: 'Rosso',
        valore: 0,
        quadrante: '',
        noteAcquisto: '',
        utilizzo: '',
        conservazione: 'Conservato in cantina',
        // Senza finestra il vino entra nella coda di arricchimento, come dall'app
        ...(dati.finestraBevuta ? {} : { aiStato: 'coda', aiCodaDal: new Date().toISOString() }),
        ...dati,
        qtaIniziale: qta,
        riconteggio: qta,
        inStock: true,
      });
      return json({
        esito: 'nuovo vino aggiunto',
        vino: riga(w),
        avviso: w.finestraBevuta ? undefined : 'Senza finestra di bevuta: il vino è in coda per l\'arricchimento automatico.',
      });
    }
  );

  server.registerTool(
    'modifica_vino',
    {
      title: 'Modifica vino',
      description:
        'Corregge o completa i dati di un vino: posizione, prezzo, note, finestra di bevuta, abbinamenti. ' +
        'Passa solo i campi da cambiare. Per bottiglie bevute usa bevi_bottiglia.',
      inputSchema: z.object({
        id: z.string(),
        azienda: z.string().optional(),
        bottiglia: z.string().optional(),
        bottiglie: z.number().int().min(0).optional().describe('Correzione del numero di bottiglie in cantina'),
        ...campiVino,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, bottiglie, ...input }) => {
      if (input.finestraBevuta && !finestraValida(input.finestraBevuta)) {
        return errore('Finestra di bevuta non valida: serve start ≤ peak ≤ end, anni tra 1900 e 2100.');
      }
      const patch = versoDB(input);
      if (bottiglie !== undefined) patch.riconteggio = bottiglie;
      if (!Object.keys(patch).length) return errore('Nessun campo da modificare.');
      const w = await patchWine(id, patch);
      return json({ esito: 'vino aggiornato', vino: riga(w) });
    }
  );

  server.registerTool(
    'bevi_bottiglia',
    {
      title: 'Segna bottiglia bevuta',
      description:
        "Toglie una bottiglia dalla cantina. Se era l'ultima, il vino passa nello storico come fa l'app. " +
        'Se l\'utente racconta com\'era (voto, impressioni, con cosa l\'ha bevuto), passalo in "nota": ' +
        'viene aggiunto con la data alle note del vino.',
      inputSchema: z.object({
        id: z.string(),
        nota: z.string().optional().describe('Impressioni di degustazione, voto, occasione'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, nota }) => {
      const w = await getWine(id);
      if (!w.inStock || !(w.riconteggio || 0)) return errore('Questo vino non ha bottiglie in cantina.');
      let aggiornato = await decrement(id);
      if (nota) {
        const data = new Date().toLocaleDateString('it-IT');
        aggiornato = await patchWine(id, { utilizzo: (w.utilizzo ? w.utilizzo + ' | ' : '') + `${data}: ${nota}` });
      }
      let esito = `bottiglia segnata come bevuta, ne restano ${aggiornato.riconteggio}`;
      if (!aggiornato.riconteggio) {
        aggiornato = await markOut(id);
        esito = "era l'ultima bottiglia: il vino è passato nello storico";
      }
      return json({ esito, vino: riga(aggiornato) });
    }
  );

  return server;
}
