// Auth multiusuario por contraseñas en secrets, sin tabla de usuarios.
// Portado de notas8: el dueño (var OWNER, por defecto "valentin") → secret
// PASSWORD; cualquier otro usuario → secret PASSWORD_<NOMBRE>.
// El rol NO va firmado en el token: se deriva del username contra la var
// WRITERS en cada request — así cambiar permisos no obliga a re-loguear.
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const COOKIE_NAME = "bitacora_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 días

// Usernames: minúsculas cortas, sin sorpresas (van dentro del token).
const USER_RE = /^[a-z0-9_-]{1,20}$/;

export type Role = "writer" | "reader";
export interface Session {
  user: string;
  role: Role;
}

type AuthEnv = {
  PASSWORD: string;
  AUTH_SECRET: string;
  OWNER?: string;
  WRITERS?: string;
  [k: string]: unknown;
};

export function ownerOf(env: AuthEnv): string {
  return (env.OWNER || "valentin").trim().toLowerCase();
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(msg),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Comparación en tiempo constante (misma implementación que notas8/twoitter).
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    result |= ca ^ cb;
  }
  return result === 0;
}

// Devuelve la contraseña esperada para un username, o null si no existe.
// El dueño usa el secret PASSWORD; el resto, PASSWORD_<USER>.
export function passwordFor(env: AuthEnv, user: string): string | null {
  if (!USER_RE.test(user)) return null;
  if (user === ownerOf(env)) return env.PASSWORD || null;
  const val = env[`PASSWORD_${user.toUpperCase()}`];
  return typeof val === "string" && val ? val : null;
}

// Escritores: el dueño siempre; el resto según la var WRITERS ("manu,ana").
export function roleFor(env: AuthEnv, user: string): Role {
  if (user === ownerOf(env)) return "writer";
  const writers = (env.WRITERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return writers.includes(user) ? "writer" : "reader";
}

// Token: issued.user.sig — el user viaja firmado; el rol se deriva al leer.
export async function makeToken(secret: string, user: string): Promise<string> {
  const issued = Date.now().toString();
  const sig = await hmac(secret, `${issued}.${user}`);
  return `${issued}.${user}.${sig}`;
}

export async function verifyToken(
  secret: string,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const [issued, user, sig] = token.split(".");
  if (!issued || !sig || !user || !USER_RE.test(user)) return null;
  const expected = await hmac(secret, `${issued}.${user}`);
  if (!timingSafeEqual(expected, sig)) return null;
  const age = Date.now() - parseInt(issued);
  return age >= 0 && age < COOKIE_MAX_AGE * 1000 ? user : null;
}

export async function setAuthCookie(c: Context, secret: string, user: string) {
  const token = await makeToken(secret, user);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

export function clearAuthCookie(c: Context) {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function getSession<E extends AuthEnv>(
  c: Context<{ Bindings: E }>,
): Promise<Session | null> {
  const token = getCookie(c, COOKIE_NAME);
  const user = await verifyToken(c.env.AUTH_SECRET, token);
  if (!user) return null;
  // el usuario debe seguir existiendo (borrar su secret = expulsarlo)
  if (!passwordFor(c.env, user)) return null;
  return { user, role: roleFor(c.env, user) };
}

// Cualquier usuario con sesión: lectura.
export function requireAuth<E extends AuthEnv>() {
  return async (c: Context<{ Bindings: E }>, next: Next) => {
    if (!(await getSession(c))) {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "no autenticado" }, 401);
      }
      return c.redirect("/login.html");
    }
    await next();
  };
}

// Solo escritores: cualquier escritura.
export function requireWriter<E extends AuthEnv>() {
  return async (c: Context<{ Bindings: E }>, next: Next) => {
    const s = await getSession(c);
    if (!s || s.role !== "writer") {
      return c.json({ error: "solo lectura" }, 403);
    }
    await next();
  };
}
