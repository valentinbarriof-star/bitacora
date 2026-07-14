// Consultas D1. Db propia (bitacora-db), tablas entries + labels.

export interface EntryRow {
  id: number;
  kind: "texto" | "audio";
  title: string | null;
  body: string | null;
  r2_key: string | null;
  content_type: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Entry extends EntryRow {
  tags: string[];
  mentions: string[];
}

export type LabelType = "tag" | "mention";

export interface LabelCount {
  value: string;
  count: number;
}

const ENTRY_COLS =
  "id, kind, title, body, r2_key, content_type, created_at, updated_at";

export async function createEntry(
  db: D1Database,
  e: {
    kind: "texto" | "audio";
    title: string | null;
    body: string | null;
    r2_key: string | null;
    content_type: string | null;
  },
): Promise<number> {
  const r = await db
    .prepare(
      "INSERT INTO entries (kind, title, body, r2_key, content_type) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(e.kind, e.title, e.body, e.r2_key, e.content_type)
    .first<{ id: number }>();
  return r!.id;
}

export async function getEntry(db: D1Database, id: number): Promise<Entry | null> {
  const e = await db
    .prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<EntryRow>();
  if (!e) return null;
  const labels = await db
    .prepare("SELECT type, value FROM labels WHERE entry_id = ?")
    .bind(id)
    .all<{ type: LabelType; value: string }>();
  return {
    ...e,
    tags: labels.results.filter((l) => l.type === "tag").map((l) => l.value),
    mentions: labels.results.filter((l) => l.type === "mention").map((l) => l.value),
  };
}

// Feed de una sección. `q` busca en título y cuerpo (LIKE); `tags` y
// `mentions` filtran por etiqueta — TODAS deben estar (AND): la pantalla
// intermedia va acotando el carrete con cada clic.
export async function listEntries(
  db: D1Database,
  opts: {
    kind?: "texto" | "audio";
    q?: string;
    tags?: string[];
    mentions?: string[];
    limit: number;
    offset: number;
  },
): Promise<Entry[]> {
  const where: string[] = ["e.deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (opts.kind) {
    where.push("e.kind = ?");
    binds.push(opts.kind);
  }
  if (opts.q) {
    where.push("(e.title LIKE ? OR e.body LIKE ?)");
    const like = `%${opts.q}%`;
    binds.push(like, like);
  }
  // AND de etiquetas: la entrada debe tener TODAS las seleccionadas. El
  // COUNT contra la PK (entry_id, type, value) no puede duplicar.
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
      `(SELECT COUNT(*) FROM labels l WHERE l.entry_id = e.id AND (${parts.join(" OR ")})) = ?`,
    );
    binds.push(...tags, ...mentions, total);
  }

  const ids = await db
    .prepare(
      `SELECT e.id FROM entries e WHERE ${where.join(" AND ")}
       ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, opts.limit, opts.offset)
    .all<{ id: number }>();
  if (ids.results.length === 0) return [];

  const list = ids.results.map((x) => x.id);
  const marks = list.map(() => "?").join(",");
  const [entries, labels] = await Promise.all([
    db
      .prepare(`SELECT ${ENTRY_COLS} FROM entries WHERE id IN (${marks})`)
      .bind(...list)
      .all<EntryRow>(),
    db
      .prepare(`SELECT entry_id, type, value FROM labels WHERE entry_id IN (${marks})`)
      .bind(...list)
      .all<{ entry_id: number; type: LabelType; value: string }>(),
  ]);

  const byId = new Map<number, Entry>();
  for (const e of entries.results) byId.set(e.id, { ...e, tags: [], mentions: [] });
  for (const l of labels.results) {
    const e = byId.get(l.entry_id);
    if (!e) continue;
    if (l.type === "tag") e.tags.push(l.value);
    else e.mentions.push(l.value);
  }
  // conservar el orden DESC de ids
  return list.map((id) => byId.get(id)!).filter(Boolean);
}

export async function setEntryText(
  db: D1Database,
  id: number,
  title: string | null,
  body: string | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE entries SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(title, body, id)
    .run();
}

export async function softDeleteEntry(db: D1Database, id: number): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE entries SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
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

// Re-sincroniza las etiquetas de una entrada a partir de su texto completo
// (título + cuerpo). Borra y re-inserta: simple y correcto.
export async function syncEntryLabels(db: D1Database, entryId: number): Promise<void> {
  const e = await getEntry(db, entryId);
  if (!e) return;
  const { tags, mentions } = extractLabels(`${e.title ?? ""}\n${e.body ?? ""}`);
  const stmts = [
    db.prepare("DELETE FROM labels WHERE entry_id = ?").bind(entryId),
    ...tags.map((v) =>
      db
        .prepare("INSERT OR IGNORE INTO labels (entry_id, type, value) VALUES (?, 'tag', ?)")
        .bind(entryId, v),
    ),
    ...mentions.map((v) =>
      db
        .prepare("INSERT OR IGNORE INTO labels (entry_id, type, value) VALUES (?, 'mention', ?)")
        .bind(entryId, v),
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
       JOIN entries e ON e.id = l.entry_id AND e.deleted_at IS NULL AND e.kind = ?
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
