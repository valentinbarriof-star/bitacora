// Consultas D1. Db propia (bitacora-db): notes + blocks + labels
// (el modelo de notas8, sin comentarios ni versiones ni anidación).

export interface NoteRow {
  id: number;
  kind: "texto" | "audio";
  title: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface BlockRow {
  id: number;
  note_id: number;
  position: number;
  kind: "text" | "audio";
  r2_key: string | null;
  content_type: string | null;
  text: string | null;
  transcript: string | null;
  transcript_original: string | null;
  transcribed_at: string | null;
  created_at: string;
}

export interface Note extends NoteRow {
  blocks: BlockRow[];
  tags: string[];
  mentions: string[];
}

export type LabelType = "tag" | "mention";

export interface LabelCount {
  value: string;
  count: number;
}

export async function createNote(
  db: D1Database,
  kind: "texto" | "audio",
  title: string | null,
): Promise<number> {
  const r = await db
    .prepare("INSERT INTO notes (kind, title) VALUES (?, ?) RETURNING id")
    .bind(kind, title)
    .first<{ id: number }>();
  return r!.id;
}

export interface NewBlock {
  kind: "text" | "audio";
  r2_key?: string | null;
  content_type?: string | null;
  text?: string | null;
  // el composer transcribe ANTES de publicar (POST /api/transcribe), así que
  // un bloque de audio puede llegar ya con su transcript (posiblemente
  // corregido a mano) y con el whisper crudo en transcript_original.
  transcript?: string | null;
  transcript_original?: string | null;
}

export async function addBlock(
  db: D1Database,
  noteId: number,
  position: number,
  b: NewBlock,
): Promise<number> {
  const transcript = b.transcript ?? null;
  const original = b.transcript_original ?? null;
  const r = await db
    .prepare(
      `INSERT INTO blocks (note_id, position, kind, r2_key, content_type, text, transcript, transcript_original, transcribed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      noteId,
      position,
      b.kind,
      b.r2_key ?? null,
      b.content_type ?? null,
      b.text ?? null,
      transcript,
      // sólo tiene sentido si difiere del transcript final
      original && original !== transcript ? original : null,
      transcript ? new Date().toISOString() : null,
    )
    .first<{ id: number }>();
  return r!.id;
}

// Feed de una sección. `q` busca en título, texto y transcripciones (LIKE);
// `tags` y `mentions` filtran por etiqueta — TODAS deben estar (AND): la
// pantalla intermedia va acotando el carrete con cada clic.
export async function listNotes(
  db: D1Database,
  opts: {
    kind?: "texto" | "audio";
    q?: string;
    tags?: string[];
    mentions?: string[];
    limit: number;
    offset: number;
  },
): Promise<Note[]> {
  const where: string[] = ["n.deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (opts.kind) {
    where.push("n.kind = ?");
    binds.push(opts.kind);
  }
  if (opts.q) {
    const like = `%${opts.q}%`;
    where.push(
      `(n.title LIKE ? OR EXISTS (
         SELECT 1 FROM blocks b WHERE b.note_id = n.id
         AND (b.text LIKE ? OR b.transcript LIKE ?)
       ))`,
    );
    binds.push(like, like, like);
  }
  // AND de etiquetas: la nota debe tener TODAS las seleccionadas. El COUNT
  // contra la PK (note_id, type, value) no puede duplicar.
  const tags = opts.tags ?? [];
  const mentions = opts.mentions ?? [];
  const total = tags.length + mentions.length;
  if (total > 0) {
    const parts: string[] = [];
    if (tags.length > 0) {
      parts.push(`(l.type = 'tag' AND l.value IN (${tags.map(() => "?").join(",")}))`);
    }
    if (mentions.length > 0) {
      parts.push(`(l.type = 'mention' AND l.value IN (${mentions.map(() => "?").join(",")}))`);
    }
    where.push(
      `(SELECT COUNT(*) FROM labels l WHERE l.note_id = n.id AND (${parts.join(" OR ")})) = ?`,
    );
    binds.push(...tags, ...mentions, total);
  }

  const ids = await db
    .prepare(
      `SELECT n.id FROM notes n WHERE ${where.join(" AND ")}
       ORDER BY n.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, opts.limit, opts.offset)
    .all<{ id: number }>();
  if (ids.results.length === 0) return [];

  const list = ids.results.map((x) => x.id);
  const marks = list.map(() => "?").join(",");
  const [notes, blocks, labels] = await Promise.all([
    db
      .prepare(
        `SELECT id, kind, title, created_at, updated_at FROM notes WHERE id IN (${marks})`,
      )
      .bind(...list)
      .all<NoteRow>(),
    db
      .prepare(`SELECT * FROM blocks WHERE note_id IN (${marks}) ORDER BY note_id, position, id`)
      .bind(...list)
      .all<BlockRow>(),
    db
      .prepare(`SELECT note_id, type, value FROM labels WHERE note_id IN (${marks})`)
      .bind(...list)
      .all<{ note_id: number; type: LabelType; value: string }>(),
  ]);

  const byId = new Map<number, Note>();
  for (const n of notes.results) byId.set(n.id, { ...n, blocks: [], tags: [], mentions: [] });
  for (const b of blocks.results) byId.get(b.note_id)?.blocks.push(b);
  for (const l of labels.results) {
    const n = byId.get(l.note_id);
    if (!n) continue;
    if (l.type === "tag") n.tags.push(l.value);
    else n.mentions.push(l.value);
  }
  // conservar el orden DESC de ids
  return list.map((id) => byId.get(id)!).filter(Boolean);
}

export async function getNote(db: D1Database, id: number): Promise<Note | null> {
  const n = await db
    .prepare(
      "SELECT id, kind, title, created_at, updated_at FROM notes WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .first<NoteRow>();
  if (!n) return null;
  const [blocks, labels] = await Promise.all([
    db
      .prepare("SELECT * FROM blocks WHERE note_id = ? ORDER BY position, id")
      .bind(id)
      .all<BlockRow>(),
    db
      .prepare("SELECT type, value FROM labels WHERE note_id = ?")
      .bind(id)
      .all<{ type: LabelType; value: string }>(),
  ]);
  return {
    ...n,
    blocks: blocks.results,
    tags: labels.results.filter((l) => l.type === "tag").map((l) => l.value),
    mentions: labels.results.filter((l) => l.type === "mention").map((l) => l.value),
  };
}

export async function getBlock(db: D1Database, id: number): Promise<BlockRow | null> {
  return db.prepare("SELECT * FROM blocks WHERE id = ?").bind(id).first<BlockRow>();
}

export async function setBlockTranscript(
  db: D1Database,
  id: number,
  transcript: string,
): Promise<string> {
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE blocks SET transcript = ?, transcribed_at = ? WHERE id = ?")
    .bind(transcript, now, id)
    .run();
  return now;
}

// Corrección manual: la PRIMERA corrección congela el whisper original en
// transcript_original (COALESCE evita machacarlo en correcciones siguientes).
export async function setBlockTranscriptEdit(
  db: D1Database,
  id: number,
  transcript: string,
): Promise<BlockRow | null> {
  await db
    .prepare(
      `UPDATE blocks
       SET transcript_original = COALESCE(transcript_original, transcript),
           transcript = ?
       WHERE id = ?`,
    )
    .bind(transcript, id)
    .run();
  return getBlock(db, id);
}

export async function setBlockText(
  db: D1Database,
  id: number,
  text: string,
): Promise<BlockRow | null> {
  await db.prepare("UPDATE blocks SET text = ? WHERE id = ?").bind(text, id).run();
  return getBlock(db, id);
}

export async function touchNote(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE notes SET updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

export async function setNoteTitle(
  db: D1Database,
  id: number,
  title: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE notes SET title = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(title, id)
    .run();
}

export async function softDeleteNote(db: D1Database, id: number): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE notes SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------- etiquetas (#tag y @mencion) ----------

const TAG_RE = /#([\p{L}\p{N}_]{1,50})/gu;
const MENTION_RE = /@([\p{L}\p{N}_]{1,50})/gu;

export function extractLabels(text: string): { tags: string[]; mentions: string[] } {
  const tags = new Set<string>();
  const mentions = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) tags.add(m[1].toLowerCase());
  for (const m of text.matchAll(MENTION_RE)) mentions.add(m[1].toLowerCase());
  return { tags: [...tags], mentions: [...mentions] };
}

// Re-sincroniza las etiquetas de una nota a partir de su texto completo
// (título + bloques). Borra y re-inserta: simple y correcto.
export async function syncNoteLabels(db: D1Database, noteId: number): Promise<void> {
  const note = await getNote(db, noteId);
  if (!note) return;
  const full = [
    note.title ?? "",
    ...note.blocks.map((b) => b.text ?? b.transcript ?? ""),
  ].join("\n");
  const { tags, mentions } = extractLabels(full);
  const stmts = [
    db.prepare("DELETE FROM labels WHERE note_id = ?").bind(noteId),
    ...tags.map((v) =>
      db
        .prepare("INSERT OR IGNORE INTO labels (note_id, type, value) VALUES (?, 'tag', ?)")
        .bind(noteId, v),
    ),
    ...mentions.map((v) =>
      db
        .prepare("INSERT OR IGNORE INTO labels (note_id, type, value) VALUES (?, 'mention', ?)")
        .bind(noteId, v),
    ),
  ];
  await db.batch(stmts);
}

// Todas las etiquetas vivas de una sección, con recuento — el material de la
// pantalla intermedia (nube de @'s y de #'s) y de la tagbar de textos.
export async function listLabels(
  db: D1Database,
  kind: "texto" | "audio",
): Promise<{ tags: LabelCount[]; mentions: LabelCount[] }> {
  const r = await db
    .prepare(
      `SELECT l.type, l.value, COUNT(*) AS count FROM labels l
       JOIN notes n ON n.id = l.note_id AND n.deleted_at IS NULL AND n.kind = ?
       GROUP BY l.type, l.value ORDER BY count DESC, l.value`,
    )
    .bind(kind)
    .all<{ type: LabelType; value: string; count: number }>();
  return {
    tags: r.results.filter((x) => x.type === "tag").map(({ value, count }) => ({ value, count })),
    mentions: r.results
      .filter((x) => x.type === "mention")
      .map(({ value, count }) => ({ value, count })),
  };
}
