# bitácora

Cuaderno de bitácora **privado** en dos secciones. Como notas8, una nota
agrupa **bloques** bajo un título opcional — pero sin comentarios ni
anidación:

- **texto** (azul): notas con bloques de texto, con `#tags` clicables que
  filtran el carrete.
- **audio** (rojo): notas con bloques de audio — grabas (o subes archivos:
  mp3, m4a, wav, ogg…), **Whisper transcribe** cada uno y el texto queda
  editable antes de publicar y corregible después (la 1ª corrección congela
  el whisper crudo en `transcript_original`). El primer pantallazo es
  topbar + composer + **nubes** = 100dvh: las `@'s` a la izquierda y los
  `#'s` a la derecha (en móvil, arriba y abajo), y cada clic acota el
  carrete que espera más abajo (los filtros se acumulan, AND). Las nubes
  nacen vacías: todo va apareciendo con el uso.

El acento de la interfaz cambia según dónde estés (azul/rojo); el resto es
gris casinegro sobre WhiteSmoke, con
[Hibur Mono](https://fonts.google.com/specimen/Hibur+Mono) auto-hospedada
(`public/fonts/`, OFL, un solo peso).

## Arquitectura

```
Navegador (SPA vanilla)  ──►  Worker bitacora (src/index.ts, Hono)
   public/                      ├─ D1  bitacora-db  (notes + blocks + labels)
   ├─ index.html (2 secciones)  ├─ R2  bitacora-audio (privado, tras auth)
   ├─ login.html                └─ Workers AI: whisper-large-v3-turbo
   └─ js/ (app, api, recorder, audio-player)
```

- Una nota (`notes`) es de texto o de audio; sus bloques (`blocks`) van en
  orden. Whisper corta párrafos por las pausas del dictado (≥1,2 s).
- Las etiquetas (`labels`) se extraen del título + bloques al crear/editar:
  `#tag` y `@mencion`, siempre en minúsculas.
- Auth por cookie firmada (HMAC), multiusuario por secrets: el dueño
  (var `OWNER`, por defecto `valentin`) usa el secret `PASSWORD`; cualquier
  otro usuario, `PASSWORD_<NOMBRE>`. Escriben el dueño y los de la var
  `WRITERS`; el resto son lectores (pueden entrar y escuchar, no publicar).

## Desarrollo

```bash
npm install
cp .dev.vars.example .dev.vars   # PASSWORD y AUTH_SECRET locales
npm run db:migrate               # aplica schema.sql a la D1 local
npm run dev                      # http://localhost:8787
```

## Deploy (primera vez)

```bash
npm run db:create                # imprime el database_id → pegarlo en wrangler.jsonc
npm run r2:create                # bucket bitacora-audio
npm run db:migrate:remote        # crea las tablas en la D1 remota
npx wrangler secret put PASSWORD     # contraseña de valentin
npx wrangler secret put AUTH_SECRET  # cadena larga aleatoria
npx wrangler secret put PASSWORD_MANU  # (opcional) más usuarios
npm run deploy
```

Dominio: por defecto queda en `bitacora.<cuenta>.workers.dev`; para un
dominio propio, añadir `routes` en `wrangler.jsonc` como en notas8.

## Export

Botón no hay: `GET /api/export` (con sesión) descarga un json con todas las
notas, sus bloques y etiquetas. Los audios viven en R2 (`audios/aa/mm/*.ext`).
