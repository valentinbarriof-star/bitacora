// ----- player de audio custom, portado de twoitter (audio-player.js) -----
//
// Markup (audioPlayerMarkup) y wiring (setupAudioPlayers) viven juntos para
// que cualquier cambio en uno fuerce mirar el otro. Quien quiera pintar un
// audio importa audioPlayerMarkup; el resto (play/pause, seek, tiempo,
// teclado) lo gestiona setupAudioPlayers via delegación global.
//
// Diferencias con el original de twoitter: aquí NO viaja el bloque de
// transcripción (notas tiene su propio sistema de texto + historial de
// versiones por bloque) y el src siempre llega explícito (blob: URL en el
// borrador, /r2/<key> en el feed).
//
// Política: sin autoplay — el usuario pulsa play. Solo un audio sonando a la
// vez (modelo radio: empezar uno pausa los demás).
//
// REPRODUCCIÓN POR WEB AUDIO: en iOS, un <audio> reproducido inline lo
// SILENCIA el interruptor de silencio del móvil. La única forma fiable de que
// suene es la Web Audio API (decodificar a un AudioBuffer y sonarlo por el
// AudioContext, que ignora ese interruptor). Por eso NO reproducimos el
// <audio>: lo usamos solo para su `src` (decodificar) y su `duration`. El
// progreso/tiempo lo lleva un reloj propio (requestAnimationFrame +
// ctx.currentTime). Fallback al elemento si no hay AudioContext o el formato
// no decodifica (p.ej. webm de escritorio en iPhone).

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export function audioPlayerMarkup({ src } = {}) {
  return `<div class="audio-player" data-state="paused">
    <button class="ap-play" type="button" aria-label="reproducir">
      <span class="ap-icon-play" aria-hidden="true">▶</span>
      <span class="ap-icon-pause" aria-hidden="true">❚❚</span>
    </button>
    <div class="ap-progress" role="slider" aria-label="progreso" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="ap-progress-fill"></div>
    </div>
    <span class="ap-time" aria-live="off">0:00<span class="ap-time-sep"> / </span><span class="ap-time-dur">--:--</span></span>
    <audio src="${escapeHtml(src)}" preload="metadata"></audio>
  </div>`;
}

function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) return '--:--';
  const total = Math.floor(t);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ----- AudioContext compartido (perezoso) -----

let audioCtx = null;
function getCtx() {
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = AC ? new AC() : null;
  } catch {
    audioCtx = null; // p.ej. límite de hardware contexts → fallback
  }
  return audioCtx;
}

// ----- estado de reproducción (en el propio nodo <audio>) -----
//   __buf / __bufPromise : AudioBuffer decodificado (cache)
//   __src                : AudioBufferSourceNode sonando, o null
//   __offset             : posición (seg) — fuente de verdad del progreso
//   __startCtx           : ctx.currentTime cuando arrancó __src
//   __raf                : id del bucle de pintado
//   __fallback           : true si caímos a reproducir el <audio> directamente

function durationOf(audio) {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return audio.__buf ? audio.__buf.duration : 0;
}

function isPlaying(audio) {
  return audio.__fallback ? !audio.paused : !!audio.__src;
}

// Posición actual en segundos (para pintar y para reanudar tras pausa/seek).
function currentOf(audio) {
  if (audio.__fallback) return audio.currentTime || 0;
  if (audio.__src) {
    const ctx = getCtx();
    // Guard de __startCtx: si por una carrera estuviera sin fijar, evita NaN
    // (que pintaría anchos NaN% / --:--).
    const elapsed = ctx && Number.isFinite(audio.__startCtx) ? ctx.currentTime - audio.__startCtx : 0;
    return Math.min(durationOf(audio), (audio.__offset || 0) + elapsed);
  }
  return audio.__offset || 0;
}

function ensureBuffer(audio) {
  if (audio.__buf) return Promise.resolve(audio.__buf);
  if (audio.__bufPromise) return audio.__bufPromise;
  const ctx = getCtx();
  if (!ctx) return Promise.reject(new Error('no AudioContext'));
  audio.__bufPromise = (async () => {
    const res = await fetch(audio.currentSrc || audio.src);
    const arr = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    audio.__buf = buf;
    return buf;
  })().catch((e) => {
    audio.__bufPromise = null;
    throw e;
  });
  return audio.__bufPromise;
}

// ----- pintado -----

function paintTime(player) {
  const audio = player.querySelector(':scope > audio');
  if (!audio) return;
  const curEl = player.querySelector('.ap-time');
  const durEl = player.querySelector('.ap-time-dur');
  if (curEl) {
    // Reescribir sólo el texto del current (primer text node), preservando
    // los spans hijos (separador + duración).
    const first = curEl.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      first.nodeValue = fmtTime(currentOf(audio));
    }
  }
  if (durEl) durEl.textContent = fmtTime(durationOf(audio));
}

function paintProgress(player) {
  const audio = player.querySelector(':scope > audio');
  if (!audio) return;
  const fill = player.querySelector('.ap-progress-fill');
  const slider = player.querySelector('.ap-progress');
  if (!fill || !slider) return;
  const dur = durationOf(audio);
  const pct = dur > 0 ? (currentOf(audio) / dur) * 100 : 0;
  fill.style.width = `${pct}%`;
  slider.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function paint(player) {
  paintTime(player);
  paintProgress(player);
}

function setPaused(player, paused) {
  player.dataset.state = paused ? 'paused' : 'playing';
  const btn = player.querySelector('.ap-play');
  if (btn) btn.setAttribute('aria-label', paused ? 'reproducir' : 'pausar');
}

// ----- bucle de pintado (rAF) -----

function cancelRaf(audio) {
  if (audio.__raf) {
    cancelAnimationFrame(audio.__raf);
    audio.__raf = null;
  }
}

function startRaf(player, audio) {
  cancelRaf(audio);
  const loop = () => {
    paint(player);
    if (!isPlaying(audio)) {
      audio.__raf = null;
      return;
    }
    audio.__raf = requestAnimationFrame(loop);
  };
  audio.__raf = requestAnimationFrame(loop);
}

// ----- fuente de sonido (Web Audio) -----

function stopSource(audio) {
  if (audio.__src) {
    try {
      audio.__src.onended = null;
      audio.__src.stop();
    } catch {}
    audio.__src = null;
  }
}

// Arranca un BufferSource desde `offset` y lo registra. Al terminar de forma
// NATURAL (no por stop manual, que limpia onended), resetea a 0.
function startSource(player, audio, ctx, buf, offset) {
  stopSource(audio);
  const off = Math.max(0, Math.min(offset, buf.duration));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, off);
  audio.__src = src;
  audio.__offset = off;
  audio.__startCtx = ctx.currentTime;
  src.onended = () => {
    if (audio.__src !== src) return; // reemplazado por un seek/stop
    audio.__src = null;
    audio.__offset = 0;
    cancelRaf(audio);
    setPaused(player, true);
    paint(player);
  };
}

// ----- play / pause / seek -----

async function play(player, audio) {
  pauseOthers(audio);
  // Fallback pegajoso: si ya caímos al elemento (sin AudioContext o un formato
  // que no decodifica), NO reintentamos Web Audio — eso re-fetcharía +
  // re-decodificaría el archivo entero para volver a fallar.
  if (audio.__fallback) { startFallback(player, audio); return; }
  // Guard de reentrada: play() es async (await resume/decode); sin esto, un
  // doble clic rápido (antes de que __src exista) lanzaría dos runs solapados.
  if (audio.__starting) return;
  audio.__starting = true;
  try {
    const ctx = getCtx();
    if (!ctx) throw new Error('no AudioContext');
    await ctx.resume(); // dentro del gesto de click → iOS desbloquea el contexto
    const buf = await ensureBuffer(audio);
    // Si la posición está al final (terminó), reinicia desde 0.
    let off = audio.__offset || 0;
    if (off >= buf.duration - 0.05) off = 0;
    startSource(player, audio, ctx, buf, off);
    setPaused(player, false);
    startRaf(player, audio);
  } catch (e) {
    // Fallback: reproducir el <audio> directamente. Puede silenciarse por el
    // interruptor en iOS, pero funciona en escritorio o con el switch quitado.
    console.warn('web audio falló, fallback al elemento', e);
    startFallback(player, audio);
  } finally {
    audio.__starting = false;
  }
}

function pause(player, audio) {
  if (audio.__fallback) {
    try { audio.pause(); } catch {}
    cancelRaf(audio);
    setPaused(player, true);
    return;
  }
  audio.__offset = currentOf(audio);
  stopSource(audio);
  cancelRaf(audio);
  setPaused(player, true);
  paint(player);
}

function toggle(player, audio) {
  if (isPlaying(audio)) pause(player, audio);
  else play(player, audio);
}

function seekTo(player, audio, t) {
  const dur = durationOf(audio);
  const clamped = Math.max(0, Math.min(t, dur || 0));
  if (audio.__fallback) {
    try { audio.currentTime = clamped; } catch {}
    paint(player);
    return;
  }
  const wasPlaying = !!audio.__src;
  audio.__offset = clamped;
  if (wasPlaying) {
    const ctx = getCtx();
    const buf = audio.__buf;
    if (ctx && buf) startSource(player, audio, ctx, buf, clamped);
  }
  paint(player);
}

// Fallback: reproducir el elemento (sin Web Audio). Cablea sus eventos una vez
// para pintar/resetear. Degradado pero audible donde no aplica el silencio.
function startFallback(player, audio) {
  audio.__fallback = true;
  stopSource(audio);
  audio.muted = false;
  audio.volume = 1;
  if (!audio.__fbWired) {
    audio.__fbWired = true;
    audio.addEventListener('timeupdate', () => paint(player));
    audio.addEventListener('ended', () => {
      setPaused(player, true);
      try { audio.currentTime = 0; } catch {}
      paint(player);
    });
  }
  audio
    .play()
    .then(() => setPaused(player, false))
    .catch((err) => console.warn('play failed', err));
}

// Pausa todos los demás players (1 audio sonando a la vez). Modelo radio.
function pauseOthers(except) {
  document.querySelectorAll('.audio-player > audio').forEach((a) => {
    if (a === except || !isPlaying(a)) return;
    const p = a.closest('.audio-player');
    if (p) pause(p, a);
  });
}

// iOS MediaRecorder (mp4) y algunos webm reportan duration=Infinity hasta
// parsear el contenedor entero. Forzar un seek enorme hace que el navegador
// calcule la duración real.
function fixInfiniteDuration(audio, player) {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return;
  const onDur = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.removeEventListener('durationchange', onDur);
      try { audio.currentTime = 0; } catch {}
      paint(player);
    }
  };
  audio.addEventListener('durationchange', onDur);
  try { audio.currentTime = 1e7; } catch {}
}

// Engancha lo mínimo al <audio> de un player. Marca el player como wired con
// dataset para no duplicar al llamar al setup global dos veces sobre el nodo.
function wirePlayer(player) {
  if (player.dataset.wired === '1') return;
  const audio = player.querySelector(':scope > audio');
  if (!audio) return;
  player.dataset.wired = '1';

  // Solo necesitamos la duración (la reproducción NO va por el elemento).
  audio.addEventListener('loadedmetadata', () => {
    fixInfiniteDuration(audio, player);
    paint(player);
  });
  // Si los metadatos ya estaban (cache), pinta de una.
  if (Number.isFinite(audio.duration) && audio.duration > 0) paint(player);
}

function seekFromPointer(player, clientX) {
  const audio = player.querySelector(':scope > audio');
  const slider = player.querySelector('.ap-progress');
  if (!audio || !slider) return;
  const dur = durationOf(audio);
  if (!dur) return;
  const rect = slider.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  seekTo(player, audio, dur * pct);
}

let wired = false;
export function setupAudioPlayers() {
  if (wired) return;
  wired = true;

  // Cualquier player que entre al DOM (borrador o feed) lo wireamos.
  // MutationObserver para que paintTime() corra en cuanto cargue la duración
  // aunque el user no haya interactuado.
  const observeNew = () => {
    document.querySelectorAll('.audio-player').forEach(wirePlayer);
  };
  observeNew();
  const mo = new MutationObserver(observeNew);
  mo.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', (e) => {
    const playBtn = e.target.closest('.audio-player .ap-play');
    if (playBtn) {
      e.stopPropagation();
      const player = playBtn.closest('.audio-player');
      const audio = player.querySelector(':scope > audio');
      if (audio) toggle(player, audio);
      return;
    }
    const slider = e.target.closest('.audio-player .ap-progress');
    if (slider) {
      e.stopPropagation();
      seekFromPointer(slider.closest('.audio-player'), e.clientX);
      return;
    }
  });

  // Teclado en el slider: flechas mueven ±5s, Home/End van a 0/dur,
  // espacio/enter play/pausa.
  document.addEventListener('keydown', (e) => {
    const slider = e.target.closest?.('.audio-player .ap-progress');
    if (!slider) return;
    const player = slider.closest('.audio-player');
    const audio = player.querySelector(':scope > audio');
    const dur = audio ? durationOf(audio) : 0;
    if (!audio || !dur) return;
    let handled = true;
    const cur = currentOf(audio);
    if (e.key === 'ArrowLeft') seekTo(player, audio, cur - 5);
    else if (e.key === 'ArrowRight') seekTo(player, audio, cur + 5);
    else if (e.key === 'Home') seekTo(player, audio, 0);
    else if (e.key === 'End') seekTo(player, audio, dur);
    else if (e.key === ' ' || e.key === 'Enter') toggle(player, audio);
    else handled = false;
    if (handled) e.preventDefault();
  });
}
