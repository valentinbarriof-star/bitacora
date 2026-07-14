import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  getSession,
  passwordFor,
  requireAuth,
  requireWriter,
  roleFor,
  ownerOf,
  setAuthCookie,
  clearAuthCookie,
  timingSafeEqual,
} from "./auth";
import {
  addBlock,
  createNote,
  getBlock,
  getNote,
  listLabels,
  listNotes,
  setBlockText,
  setBlockTranscript,
  setBlockTranscriptEdit,
  setNoteTitle,
  softDeleteNote,
  syncNoteLabels,
  touchNote,
  type NewBlock,
} from "./db";
import { buildAudioKey, classifyAudio, MAX_AUDIO_BYTES, uint8ToBase64 } from "./media";

// ---------- config ----------

// Castellano fijo, como en notas8: evita que audios cortos se detecten como
// portugués/italiano. null → auto-detect.
const WHISPER_LANGUAGE: string | null = "es";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// Pausa (en segundos) entre segmentos de Whisper que consideramos "punto y
// aparte". notas8 usa 0.5 (manu habla rápido); aquí arrancamos en el punto
// dulce probado en twoitter (1.0-1.4) hasta conocer el dictado de valentin.
const PARAGRAPH_GAP_S = 1.2;

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Una clave R2 nuestra tiene el formato que produce buildAudioKey:
// audios/aa/mm/<24 hex>.<ext>. Solo aceptamos claves con esta forma.
const AUDIO_KEY_RE = /^audios\/\d{2}\/\d{2}\/[a-f0-9]{24}\.[a-z0-9]+$/;

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

type Bindings = {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;
  PASSWORD: string;
  AUTH_SECRET: string;
  OWNER?: string;
  WRITERS?: string;
  WRITE_LIMITER: RateLimit;
  TRANSCRIBE_LIMITER: RateLimit;
  [k: string]: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
  console.error("worker error:", err?.message, err?.stack);
  return c.json({ error: "internal" }, 500);
});

// CSRF: los writes exigen un header custom que un form HTML no puede poner.
function requireCsrf() {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    if (c.req.header("x-bitacora-csrf") !== "1") {
      return c.json({ error: "csrf" }, 403);
    }
    await next();
  };
}

function rateLimit(pick: (e: Bindings) => RateLimit) {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const ip = c.req.header("cf-connecting-ip") || "local";
    const { success } = await pick(c.env).limit({ key: ip });
    if (!success) return c.json({ error: "demasiadas peticiones" }, 429);
    await next();
  };
}

// ---------- auth ----------

// Multiusuario: el dueño (var OWNER) → PASSWORD, cualquier otro → secret
// PASSWORD_<NOMBRE>. Escriben el dueño y los que estén en la var WRITERS.
app.post("/api/login", async (c) => {
  let body: { user?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const user = (body.user ?? ownerOf(c.env)).trim().toLowerCase();
  const pw = body.password ?? "";
  const expected = passwordFor(c.env, user);
  // se compara siempre (contra "" si el usuario no existe) para no filtrar
  // por timing qué usuarios existen
  if (!pw || !timingSafeEqual(pw, expected ?? "") || !expected) {
    return c.json({ error: "usuario o contraseña incorrectos" }, 401);
  }
  await setAuthCookie(c, c.env.AUTH_SECRET, user);
  return c.json({ ok: true, user, role: roleFor(c.env, user) });
});

app.post("/api/logout", async (c) => {
  clearAuthCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const s = await getSession(c);
  return c.json({ authed: !!s, user: s?.user ?? null, role: s?.role ?? null });
});

// ---------- notas ----------

function parseKind(raw: string | undefined): "texto" | "audio" | undefined {
  return raw === "texto" || raw === "audio" ? raw : undefined;
}

// lista separada por comas → valores normalizados (para tags= y mentions=)
function parseValues(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

app.get("/api/notes", requireAuth(), async (c) => {
  const kind = parseKind(c.req.query("kind"));
  const q = c.req.query("q")?.trim() || undefined;
  const tags = parseValues(c.req.query("tags"));
  const mentions = parseValues(c.req.query("mentions"));
  const limit = Math.min(parseInt(c.req.query("limit") || "30") || 30, 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);
  const notes = await listNotes(c.env.DB, { kind, q, tags, mentions, limit, offset });
  return c.json({ notes, limit, offset });
});

app.get("/api/notes/:id", requireAuth(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const note = await getNote(c.env.DB, id);
  if (!note) return c.json({ error: "no encontrada" }, 404);
  return c.json(note);
});

interface NotePostBody {
  kind?: string;
  title?: string | null;
  blocks?: NewBlock[];
}

app.post("/api/notes", requireWriter(), requireCsrf(), rateLimit((e) => e.WRITE_LIMITER), async (c) => {
  let body: NotePostBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const kind = parseKind(typeof body.kind === "string" ? body.kind : undefined);
  if (!kind) return c.json({ error: "kind invalido (texto|audio)" }, 400);

  const title = typeof body.title === "string" ? body.title.trim() || null : null;
  if (title && title.length > 300) return c.json({ error: "título demasiado largo" }, 400);

  // cada sección agrupa SUS bloques: texto → text, audio → audio
  const wantKind = kind === "texto" ? "text" : "audio";
  const blocks = (body.blocks ?? []).filter(
    (b) =>
      (b.kind === "text" && (b.text ?? "").trim()) ||
      (b.kind === "audio" && b.r2_key),
  );
  if (blocks.length === 0) return c.json({ error: "nota vacia" }, 400);
  for (const b of blocks) {
    if (b.kind !== wantKind) {
      return c.json({ error: `una nota de ${kind} solo lleva bloques de ${wantKind}` }, 400);
    }
    if (b.kind === "text" && (b.text ?? "").length > 20000) {
      return c.json({ error: "bloque demasiado largo" }, 400);
    }
    if ((b.transcript ?? "").length > 20000) {
      return c.json({ error: "transcripción demasiado larga" }, 400);
    }
    // El r2_key debe ser nuestro (audios/…): no aceptamos claves arbitrarias.
    if (b.kind === "audio" && !AUDIO_KEY_RE.test(String(b.r2_key ?? ""))) {
      return c.json({ error: "r2_key invalido" }, 400);
    }
  }

  const noteId = await createNote(c.env.DB, kind, title);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    await addBlock(c.env.DB, noteId, i, {
      kind: b.kind,
      r2_key: b.kind === "audio" ? b.r2_key : null,
      content_type: b.kind === "audio" ? (b.content_type ?? null)?.slice(0, 100) : null,
      text: b.kind === "text" ? (b.text ?? "").trim() || null : null,
      // el composer transcribe antes de publicar; el audio llega con el texto
      // final y el whisper crudo aparte
      transcript: b.kind === "audio" ? (b.transcript ?? "").trim() || null : null,
      transcript_original: b.kind === "audio" ? (b.transcript_original ?? "").trim() || null : null,
    });
  }
  await syncNoteLabels(c.env.DB, noteId);
  return c.json(await getNote(c.env.DB, noteId), 201);
});

app.patch("/api/notes/:id", requireWriter(), requireCsrf(), rateLimit((e) => e.WRITE_LIMITER), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  let body: { title?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const existing = await getNote(c.env.DB, id);
  if (!existing) return c.json({ error: "no encontrada" }, 404);
  const title = typeof body.title === "string" ? body.title.trim() || null : null;
  if (title && title.length > 300) return c.json({ error: "título demasiado largo" }, 400);
  await setNoteTitle(c.env.DB, id, title);
  await syncNoteLabels(c.env.DB, id);
  return c.json(await getNote(c.env.DB, id));
});

app.delete("/api/notes/:id", requireWriter(), requireCsrf(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const ok = await softDeleteNote(c.env.DB, id);
  if (!ok) return c.json({ error: "no encontrada" }, 404);
  return c.json({ ok: true });
});

// Corregir un bloque: texto → text; audio → transcript (la 1ª corrección
// congela el whisper crudo en transcript_original, como en notas8).
app.patch("/api/blocks/:id", requireWriter(), requireCsrf(), rateLimit((e) => e.WRITE_LIMITER), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  let body: { text?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "texto vacio" }, 400);
  if (text.length > 20000) return c.json({ error: "texto demasiado largo" }, 400);

  const block = await getBlock(c.env.DB, id);
  if (!block) return c.json({ error: "bloque no encontrado" }, 404);
  if (block.kind === "audio" && !block.transcript) {
    return c.json({ error: "audio sin transcribir; transcribe primero" }, 409);
  }
  const current = block.kind === "audio" ? block.transcript : block.text;
  if (text === current) return c.json({ error: "sin cambios" }, 400);

  const updated =
    block.kind === "audio"
      ? await setBlockTranscriptEdit(c.env.DB, id, text)
      : await setBlockText(c.env.DB, id, text);
  await touchNote(c.env.DB, block.note_id);
  await syncNoteLabels(c.env.DB, block.note_id);
  return c.json(updated);
});

// ---------- etiquetas ----------

// Las nubes de la pantalla intermedia (audio: @'s y #'s) y la tagbar de
// textos salen de aquí: etiquetas vivas de la sección con su recuento.
app.get("/api/labels", requireAuth(), async (c) => {
  const kind = parseKind(c.req.query("kind")) ?? "audio";
  return c.json(await listLabels(c.env.DB, kind));
});

// ---------- upload ----------

// Subida a R2 de un audio (grabado o archivo). Doble validación de tamaño:
// por el content-length declarado (rechazo temprano) y tras leer el body.
app.post("/api/upload", requireWriter(), requireCsrf(), rateLimit((e) => e.WRITE_LIMITER), async (c) => {
  const ct = c.req.header("x-content-type") || c.req.header("content-type") || "";
  const classified = classifyAudio(ct);
  if (!classified) return c.json({ error: "tipo de audio no permitido" }, 400);

  const declared = parseInt(c.req.header("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    return c.json({ error: "audio demasiado grande" }, 413);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_AUDIO_BYTES) {
    return c.json({ error: "audio demasiado grande" }, 413);
  }
  if (body.byteLength === 0) return c.json({ error: "audio vacio" }, 400);

  const key = buildAudioKey(classified.ext);
  await c.env.STORAGE.put(key, body, { httpMetadata: { contentType: ct } });
  return c.json({ key, url: `/r2/${key}` });
});

// ---------- transcripción (whisper, portada de notas8) ----------

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

// Convierte los segmentos de Whisper en párrafos: pausa >= PARAGRAPH_GAP_S
// entre un segmento y el siguiente = punto y aparte. Determinista y gratis;
// respeta la respiración del dictado.
export function paragraphsFromSegments(
  segments: WhisperSegment[],
  gapS = PARAGRAPH_GAP_S,
): string {
  const paras: string[] = [];
  let cur: string[] = [];
  let prevEnd: number | null = null;
  for (const s of segments) {
    const t = (s.text || "").trim();
    if (!t) continue;
    if (prevEnd !== null && s.start - prevEnd >= gapS && cur.length > 0) {
      paras.push(cur.join(" "));
      cur = [];
    }
    cur.push(t);
    prevEnd = s.end;
  }
  if (cur.length > 0) paras.push(cur.join(" "));
  return paras.join("\n\n");
}

// Llama a Whisper sobre un objeto de R2 y devuelve el transcript con párrafos
// (cortados por pausas entre segments; si no hay segments, texto plano).
async function whisperTranscribe(
  env: Bindings,
  r2Key: string,
): Promise<{ ok: true; transcript: string } | { ok: false; status: 404 | 422 | 500; error: string }> {
  const obj = await env.STORAGE.get(r2Key);
  if (!obj) return { ok: false, status: 404, error: "audio no encontrado en r2" };
  const audioBytes = await obj.arrayBuffer();
  const base64 = uint8ToBase64(new Uint8Array(audioBytes));

  let transcript: string;
  try {
    const inputs: { audio: string; language?: string } = { audio: base64 };
    if (WHISPER_LANGUAGE) inputs.language = WHISPER_LANGUAGE;
    const result = (await env.AI.run(WHISPER_MODEL as never, inputs as never)) as {
      text?: string;
      transcription?: string;
      segments?: WhisperSegment[];
    } | null;
    const plain = ((result?.text ?? result?.transcription) || "").trim();
    const segs = Array.isArray(result?.segments) ? result.segments : [];
    transcript = segs.length > 1 ? paragraphsFromSegments(segs) : plain;
    if (!transcript) transcript = plain;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("whisper failed:", msg);
    return { ok: false, status: 500, error: `fallo al transcribir: ${msg}` };
  }
  if (!transcript) return { ok: false, status: 422, error: "transcripción vacía" };
  return { ok: true, transcript };
}

// Transcripción EN EL COMPOSER, antes de que exista la nota: recibe el r2_key
// devuelto por /api/upload y devuelve el texto SIN persistir nada. El texto
// (corregido o no) viaja luego en el bloque al hacer POST /api/notes.
app.post("/api/transcribe", requireWriter(), requireCsrf(), rateLimit((e) => e.TRANSCRIBE_LIMITER), async (c) => {
  let body: { r2_key?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const key = body.r2_key ?? "";
  if (!AUDIO_KEY_RE.test(key)) {
    return c.json({ error: "r2_key invalido" }, 400);
  }
  const r = await whisperTranscribe(c.env, key);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, transcript: r.transcript });
});

// Transcribe UN bloque ya guardado (para audios antiguos o si el composer
// falló a mitad). Idempotente: si ya hay transcript, lo devuelve cacheado.
app.post("/api/blocks/:id/transcribe", requireWriter(), requireCsrf(), rateLimit((e) => e.TRANSCRIBE_LIMITER), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);

  const block = await getBlock(c.env.DB, id);
  if (!block || block.kind !== "audio" || !block.r2_key) {
    return c.json({ error: "bloque de audio no encontrado" }, 404);
  }
  if (block.transcript) {
    return c.json({
      ok: true,
      transcript: block.transcript,
      transcribed_at: block.transcribed_at,
      cached: true,
    });
  }

  const r = await whisperTranscribe(c.env, block.r2_key);
  if (!r.ok) return c.json({ error: r.error }, r.status);

  const transcribed_at = await setBlockTranscript(c.env.DB, id, r.transcript);
  await syncNoteLabels(c.env.DB, block.note_id);
  return c.json({ ok: true, transcript: r.transcript, transcribed_at, cached: false });
});

// ---------- export ----------

app.get("/api/export", requireAuth(), async (c) => {
  const notes = await listNotes(c.env.DB, { limit: 10000, offset: 0 });
  return new Response(JSON.stringify(notes, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="bitacora-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

// ---------- R2 (privado: bitácora personal, detrás de auth) ----------

app.get("/r2/*", requireAuth(), async (c) => {
  const key = c.req.path.replace(/^\/r2\//, "");
  const rangeHeader = c.req.header("range");
  const obj = await c.env.STORAGE.get(
    key,
    rangeHeader ? { range: c.req.raw.headers } : undefined,
  );
  if (!obj) return c.notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  // private: que ningún proxy compartido cachee tu voz.
  headers.set("cache-control", "private, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");

  if (rangeHeader && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix != null ? obj.size - r.suffix : r.offset ?? 0;
    const length = r.suffix != null ? r.suffix : r.length ?? obj.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
});

// ---------- HTML ----------

// Bitácora privada: la portada exige sesión; sin ella → login.
app.get("/", requireAuth(), (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))),
);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
