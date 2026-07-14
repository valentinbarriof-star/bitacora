-- bitácora — db propia (bitacora-db), sin prefijos.
-- Todo aditivo e idempotente: seguro de re-ejecutar.
-- (v2: modelo de notas8 — notas con bloques. migrations/001-notes.sql
--  tira las tablas planas de la v1, que nunca llegaron a tener datos.)

-- Una nota = una entrada de la bitácora: un título opcional y sus bloques.
--   kind='texto' → bloques de texto
--   kind='audio' → bloques de audio (con transcripción whisper corregible)
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('texto', 'audio')),
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_kind ON notes(kind, id);

-- Bloques de una nota, en orden. Cada audio grabado es UN bloque.
--   kind='text'  → text
--   kind='audio' → r2_key + content_type + transcript(es)
-- transcript_original congela lo que dijo whisper en la 1ª corrección
-- manual (mismo patrón que notas8): lo tuyo se edita, lo del modelo no
-- se pierde.
CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    position INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK(kind IN ('text', 'audio')),
    r2_key TEXT,
    content_type TEXT,
    text TEXT,
    transcript TEXT,
    transcript_original TEXT,
    transcribed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blocks_note ON blocks(note_id, position);

-- Etiquetas sueltas en el texto de una nota: #tag y @mencion. Se
-- re-sincronizan al crear/editar la nota entera (título + bloques).
CREATE TABLE IF NOT EXISTS labels (
    note_id INTEGER NOT NULL REFERENCES notes(id),
    type TEXT NOT NULL CHECK(type IN ('tag', 'mention')),
    value TEXT NOT NULL,
    PRIMARY KEY (note_id, type, value)
);

CREATE INDEX IF NOT EXISTS idx_labels_value ON labels(type, value);
