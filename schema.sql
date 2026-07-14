-- bitácora — db propia (bitacora-db), sin prefijos.
-- Todo aditivo e idempotente: seguro de re-ejecutar.

-- Una entrada = un texto o un audio del cuaderno de bitácora.
--   kind='texto' → title + body (el contenido)
--   kind='audio' → r2_key + content_type + body (el texto que acompaña,
--                  donde viven las @menciones y los #tags)
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('texto', 'audio')),
    title TEXT,
    body TEXT,
    r2_key TEXT,
    content_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind, id);

-- Etiquetas sueltas en el texto de una entrada: #tag y @mencion.
-- Se re-sincronizan al crear/editar la entrada entera.
CREATE TABLE IF NOT EXISTS labels (
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    type TEXT NOT NULL CHECK(type IN ('tag', 'mention')),
    value TEXT NOT NULL,
    PRIMARY KEY (entry_id, type, value)
);

CREATE INDEX IF NOT EXISTS idx_labels_value ON labels(type, value);
