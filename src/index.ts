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
  createEntry,
  getEntry,
  listEntries,
  listLabels,
  setEntryText,
  softDeleteEntry,
  syncEntryLabels,
} from "./db";
import { buildAudioKey, classifyAudio, MAX_AUDIO_BYTES } from "./media";

// ---------- config ----------

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
  PASSWORD: string;
  AUTH_SECRET: string;
  OWNER?: string;
  WRITERS?: string;
  WRITE_LIMITER: RateLimit;
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

function rateLimit() {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const ip = c.req.header("cf-connecting-ip") || "local";
    const { success } = await c.env.WRITE_LIMITER.limit({ key: ip });
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

// ---------- entradas ----------

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

app.get("/api/entries", requireAuth(), async (c) => {
  const kind = parseKind(c.req.query("kind"));
  const q = c.req.query("q")?.trim() || undefined;
  const tags = parseValues(c.req.query("tags"));
  const mentions = parseValues(c.req.query("mentions"));
  const limit = Math.min(parseInt(c.req.query("limit") || "30") || 30, 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0") || 0, 0);
  const entries = await listEntries(c.env.DB, { kind, q, tags, mentions, limit, offset });
  return c.json({ entries, limit, offset });
});

app.get("/api/entries/:id", requireAuth(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const entry = await getEntry(c.env.DB, id);
  if (!entry) return c.json({ error: "no encontrada" }, 404);
  return c.json(entry);
});

interface EntryPostBody {
  kind?: string;
  title?: string | null;
  body?: string | null;
  r2_key?: string | null;
  content_type?: string | null;
}

app.post("/api/entries", requireWriter(), requireCsrf(), rateLimit(), async (c) => {
  let body: EntryPostBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const kind = parseKind(typeof body.kind === "string" ? body.kind : undefined);
  if (!kind) return c.json({ error: "kind invalido (texto|audio)" }, 400);

  const title = typeof body.title === "string" ? body.title.trim() || null : null;
  const text = typeof body.body === "string" ? body.body.trim() || null : null;
  if (title && title.length > 300) return c.json({ error: "título demasiado largo" }, 400);
  if (text && text.length > 20000) return c.json({ error: "texto demasiado largo" }, 400);

  let r2_key: string | null = null;
  let content_type: string | null = null;
  if (kind === "texto") {
    if (!text) return c.json({ error: "entrada vacia" }, 400);
  } else {
    // El r2_key debe ser nuestro (audios/…): no aceptamos claves arbitrarias.
    if (!AUDIO_KEY_RE.test(String(body.r2_key ?? ""))) {
      return c.json({ error: "r2_key invalido" }, 400);
    }
    r2_key = String(body.r2_key);
    content_type =
      typeof body.content_type === "string" ? body.content_type.slice(0, 100) : null;
  }

  const id = await createEntry(c.env.DB, { kind, title, body: text, r2_key, content_type });
  await syncEntryLabels(c.env.DB, id);
  return c.json(await getEntry(c.env.DB, id), 201);
});

app.patch("/api/entries/:id", requireWriter(), requireCsrf(), rateLimit(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  let body: { title?: string | null; body?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const existing = await getEntry(c.env.DB, id);
  if (!existing) return c.json({ error: "no encontrada" }, 404);

  // sin campo en el body = se conserva lo que había (PATCH de verdad)
  const title =
    body.title === undefined
      ? existing.title
      : typeof body.title === "string"
        ? body.title.trim() || null
        : null;
  const text =
    body.body === undefined
      ? existing.body
      : typeof body.body === "string"
        ? body.body.trim() || null
        : null;
  if (title && title.length > 300) return c.json({ error: "título demasiado largo" }, 400);
  if (text && text.length > 20000) return c.json({ error: "texto demasiado largo" }, 400);
  if (existing.kind === "texto" && !text) return c.json({ error: "entrada vacia" }, 400);

  await setEntryText(c.env.DB, id, title, text);
  await syncEntryLabels(c.env.DB, id);
  return c.json(await getEntry(c.env.DB, id));
});

app.delete("/api/entries/:id", requireWriter(), requireCsrf(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const ok = await softDeleteEntry(c.env.DB, id);
  if (!ok) return c.json({ error: "no encontrada" }, 404);
  return c.json({ ok: true });
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
app.post("/api/upload", requireWriter(), requireCsrf(), rateLimit(), async (c) => {
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

// ---------- export ----------

app.get("/api/export", requireAuth(), async (c) => {
  const entries = await listEntries(c.env.DB, { limit: 10000, offset: 0 });
  return new Response(JSON.stringify(entries, null, 2), {
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
