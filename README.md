# bitácora

Cuaderno de bitácora **privado** en dos secciones:

- **texto** (azul): entradas con título y contenido, con `#tags` clicables
  que filtran el carrete. Como funciona notas8.
- **audio** (rojo): grabaciones (o archivos de audio) acompañadas de un texto
  que puede llevar `@menciones` y `#tags`. Antes del carrete hay una
  **pantalla intermedia**: lo que queda hasta los 100dvh partido en dos nubes
  — las `@'s` a la izquierda y los `#'s` a la derecha (en móvil, arriba y
  abajo). Cada clic acota el carrete que espera más abajo (los filtros se
  acumulan, AND).

El acento de la interfaz cambia según dónde estés (azul/rojo); el resto es
gris casinegro sobre WhiteSmoke, con
[Hibur Mono](https://fonts.google.com/specimen/Hibur+Mono) auto-hospedada
(`public/fonts/`, OFL, un solo peso).

Nieta de notas8 (misma arquitectura, recortada: sin whisper, sin bloques,
sin comentarios ni versiones).

## Arquitectura

```
Navegador (SPA vanilla)  ──►  Worker bitacora (src/index.ts, Hono)
   public/                      ├─ D1  bitacora-db   (entries + labels)
   ├─ index.html (2 secciones)  └─ R2  bitacora-audio (privado, tras auth)
   ├─ login.html
   └─ js/ (app, api, recorder, audio-player)
```

- Una entrada (`entries`) es un texto (`kind='texto'`: title + body) o un
  audio (`kind='audio'`: r2_key + body).
- Las etiquetas (`labels`) se extraen del título + cuerpo al crear/editar:
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
entradas y sus etiquetas. Los audios viven en R2 (`audios/aa/mm/*.ext`).
