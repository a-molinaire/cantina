-- Archivio della cantina: le stesse chiavi che c'erano su KV (db, snapshot:AAAA-MM-GG, coda_meta, ...).
-- versione cresce a ogni scrittura: serve a non sovrascrivere un salvataggio arrivato nel frattempo.
CREATE TABLE IF NOT EXISTS kv (
  chiave   TEXT PRIMARY KEY,
  valore   TEXT NOT NULL,
  versione INTEGER NOT NULL DEFAULT 1
);
