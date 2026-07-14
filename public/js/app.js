// bitácora — app principal. Como notas8, en dos secciones y sin comentarios
// ni anidación: una nota agrupa BLOQUES bajo un título opcional.
//
//   texto (AZUL): bloques de texto. Composer arriba, tagbar, carrete.
//
//   audio (ROJO): bloques de audio — grabas (o subes archivos), whisper
//   transcribe cada uno y el texto queda editable antes de publicar (y
//   corregible después: la 1ª corrección congela el whisper original).
//   El primer pantallazo es topbar + composer + nubes = 100dvh: las @'s a
//   la izquierda, los #'s a la derecha (en móvil arriba/abajo), y cada
//   clic acota el carrete que espera más abajo (filtros acumulables, AND).

import { apiGet, apiJson, uploadAudio, logout } from './api.js';
import { canRecord, createRecorder } from './recorder.js';
import { audioPlayerMarkup, setupAudioPlayers } from './audio-player.js';

const $ = (sel) => document.querySelector(sel);

// sesión actual — la rellena boot() desde /api/me
let ME = { user: null, role: null };

// ---------- toast ----------

let toastTimer = null;
function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- estado ----------

const LIMIT = 30;

const state = {
  section: 'texto',
  texto: {
    q: '', tag: '',
    notes: [], offset: 0, done: false, loaded: false,
    draft: [], // bloques {kind:'text', text}
  },
  audio: {
    q: '',
    tags: new Set(),      // filtros # activos (acumulables)
    mentions: new Set(),  // filtros @ activos (acumulables)
    notes: [], offset: 0, done: false, loaded: false,
    labels: { tags: [], mentions: [] },
    draft: [], // bloques {kind:'audio', r2_key, url, transcript, …}
  },
};

// ---------- util ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// pinta #tags y @menciones como spans clicables dentro de texto YA escapado
function withLabels(escaped) {
  return escaped
    .replace(/#([\p{L}\p{N}_]{1,50})/gu, '<span class="hashtag" data-tag="$1">#$1</span>')
    .replace(/@([\p{L}\p{N}_]{1,50})/gu, '<span class="mention" data-mention="$1">@$1</span>');
}

// URLs → enlaces (portado de notas8, recortado a esquema explícito). Seguro
// sin validar con new URL porque el texto llega YA escapado.
const URL_RE = /(https?:\/\/[^\s<]+)/gi;

function linkHtml(raw) {
  const m = /[.,;:!?]+$/.exec(raw);
  const trail = m ? m[0] : '';
  const u = trail ? raw.slice(0, -trail.length) : raw;
  return `<a class="link" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>${trail}`;
}

// Enlaces + etiquetas sobre texto escapado. Se parte por URLs ANTES de buscar
// etiquetas para que un #fragmento dentro de una URL no se convierta en tag.
function withLinksAndLabels(escaped) {
  return escaped
    .split(URL_RE)
    .map((part, i) => (i % 2 ? linkHtml(part) : withLabels(part)))
    .join('');
}

function parseDate(iso) {
  return new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
}

function fmtDate(iso) {
  return parseDate(iso).toLocaleDateString('es-ES', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function fmtTime(iso) {
  return parseDate(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

// textarea que crece con el contenido
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function renderParagraphs(container, text) {
  for (const para of text.split(/\n{2,}/)) {
    const p = document.createElement('p');
    p.innerHTML = withLinksAndLabels(esc(para));
    container.appendChild(p);
  }
}

// ---------- secciones ----------

// La topbar es sticky y su alto real manda en el 100dvh del hero de audio.
function measureTopbar() {
  const h = $('.topbar').offsetHeight;
  document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}

function setSection(section, { push = true } = {}) {
  if (section !== 'texto' && section !== 'audio') section = 'texto';
  state.section = section;
  document.body.dataset.section = section;
  document.querySelectorAll('.view').forEach((v) => {
    v.hidden = v.dataset.view !== section;
  });
  $('#search').value = state[section].q;
  if (push && location.hash !== `#${section}`) {
    history.replaceState(null, '', `#${section}`);
  }
  if (!state[section].loaded) {
    reload(section).catch((err) => toast(err.message, 'error'));
  }
}

// ---------- carga ----------

function queryFor(section, offset) {
  const s = state[section];
  const params = new URLSearchParams({ kind: section, limit: LIMIT, offset });
  if (s.q) params.set('q', s.q);
  if (section === 'texto' && s.tag) params.set('tags', s.tag);
  if (section === 'audio') {
    if (s.tags.size) params.set('tags', [...s.tags].join(','));
    if (s.mentions.size) params.set('mentions', [...s.mentions].join(','));
  }
  return params;
}

async function fetchNotes(section, offset) {
  const { notes } = await apiGet(`/api/notes?${queryFor(section, offset)}`);
  return notes;
}

async function reload(section) {
  const s = state[section];
  s.offset = 0;
  const [notes, labels] = await Promise.all([
    fetchNotes(section, 0),
    apiGet(`/api/labels?kind=${section}`),
  ]);
  s.notes = notes;
  s.done = notes.length < LIMIT;
  s.loaded = true;
  renderFeed(section);
  if (section === 'texto') {
    renderTagbar(labels.tags);
  } else {
    s.labels = labels;
    renderClouds();
  }
}

async function loadMore(section) {
  const s = state[section];
  s.offset += LIMIT;
  const notes = await fetchNotes(section, s.offset);
  s.notes.push(...notes);
  s.done = notes.length < LIMIT;
  renderFeed(section);
}

// ---------- feed: notas con bloques ----------

function prefixFor(section) {
  return section === 'texto' ? '#t' : '#a';
}

function noteHead(note, prefix) {
  const head = document.createElement('div');
  head.className = 'entry-head';
  head.innerHTML =
    `<span class="entry-num">${prefix}${note.id}</span>` +
    (note.title ? `<span class="entry-title">${esc(note.title)}</span>` : '') +
    `<span>${fmtDate(note.created_at)} · ${fmtTime(note.created_at)}</span>`;
  return head;
}

// Convierte la cabecera en un input inline para el título (writer). El PATCH
// re-sincroniza las etiquetas en el server (el título también cuenta).
function editTitleUI(head, note, prefix) {
  const num = document.createElement('span');
  num.className = 'entry-num';
  num.textContent = `${prefix}${note.id}`;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-edit';
  input.value = note.title || '';
  input.placeholder = 'título (opcional, los #tags cuentan)';

  const save = document.createElement('button');
  save.textContent = 'guardar';
  save.className = 'save';
  const cancel = document.createElement('button');
  cancel.textContent = 'cancelar';
  cancel.addEventListener('click', () => renderFeed(note.kind));
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await apiJson('PATCH', `/api/notes/${note.id}`, { title: input.value });
      toast('título guardado');
      await reload(note.kind);
    } catch (err) {
      toast(err.message, 'error');
      save.disabled = false;
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save.click();
    if (e.key === 'Escape') renderFeed(note.kind);
  });

  head.classList.add('title-editing');
  head.replaceChildren(num, input, save, cancel);
  input.focus();
}

// Editor inline de un bloque (texto o transcripción de audio).
function editBlockUI(wrap, note, b, content) {
  const body = wrap.querySelector('.entry-body');
  const ta = document.createElement('textarea');
  ta.className = 'editing grow';
  ta.value = content;
  ta.addEventListener('input', () => autoGrow(ta));
  const save = document.createElement('button');
  save.textContent = 'guardar';
  const cancel = document.createElement('button');
  cancel.textContent = 'cancelar';
  const bar = document.createElement('div');
  bar.className = 'edit-bar';
  bar.append(save, cancel);
  body.replaceChildren(ta, bar);
  autoGrow(ta);

  cancel.addEventListener('click', () => renderFeed(note.kind));
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await apiJson('PATCH', `/api/blocks/${b.id}`, { text: ta.value });
      toast('guardado');
      await reload(note.kind);
    } catch (err) {
      toast(err.message, 'error');
      save.disabled = false;
    }
  });
}

function renderBlock(note, b) {
  const wrap = document.createElement('div');
  wrap.className = 'block';
  wrap.dataset.block = b.id;

  const text = b.kind === 'audio' ? (b.transcript ?? '') : (b.text ?? '');
  const body = document.createElement('div');
  body.className = 'entry-body';
  if (text) renderParagraphs(body, text);
  wrap.appendChild(body);

  // meta-línea: audio plegado + transcribir/corregir
  const meta = document.createElement('div');
  meta.className = 'block-meta';

  if (b.kind === 'audio' && b.r2_key) {
    const audioBtn = document.createElement('button');
    audioBtn.textContent = '▸ audio';
    audioBtn.addEventListener('click', () => {
      // player custom (Web Audio: suena en iPhone aunque el interruptor de
      // silencio esté puesto). Plegado por defecto y sin autoplay.
      let player = wrap.querySelector('.audio-player');
      if (player) {
        player.hidden = !player.hidden;
        audioBtn.textContent = player.hidden ? '▸ audio' : '▾ audio';
        return;
      }
      const holder = document.createElement('div');
      holder.innerHTML = audioPlayerMarkup({ src: `/r2/${b.r2_key}` });
      player = holder.firstElementChild;
      meta.after(player);
      audioBtn.textContent = '▾ audio';
    });
    meta.appendChild(audioBtn);

    if (!b.transcript) {
      const btn = document.createElement('button');
      btn.className = 'writer-only';
      btn.textContent = 'transcribir';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await apiJson('POST', `/api/blocks/${b.id}/transcribe`);
          await reload(note.kind);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
      meta.appendChild(btn);
    }
  }

  if (text && b.id) {
    const edit = document.createElement('button');
    edit.className = 'writer-only';
    edit.textContent = 'corregir';
    edit.addEventListener('click', () => editBlockUI(wrap, note, b, text));
    meta.appendChild(edit);
  }

  if (meta.children.length > 0) wrap.appendChild(meta);
  return wrap;
}

function renderNote(section, note) {
  const article = document.createElement('article');
  article.className = 'entry';
  article.dataset.note = note.id;
  const prefix = prefixFor(section);

  article.appendChild(noteHead(note, prefix));
  for (const b of note.blocks) article.appendChild(renderBlock(note, b));

  const foot = document.createElement('div');
  foot.className = 'entry-meta';

  const editTitle = document.createElement('button');
  editTitle.className = 'writer-only';
  editTitle.textContent = note.title ? 'editar título' : '+ título';
  editTitle.addEventListener('click', () =>
    editTitleUI(article.querySelector('.entry-head'), note, prefix),
  );
  foot.appendChild(editTitle);

  const del = document.createElement('button');
  del.className = 'writer-only del';
  del.textContent = 'borrar';
  del.addEventListener('click', async () => {
    if (!confirm(`¿borrar la nota ${prefix}${note.id} entera?`)) return;
    del.disabled = true;
    try {
      await apiJson('DELETE', `/api/notes/${note.id}`);
      toast('borrada');
      await reload(section);
    } catch (err) {
      toast(err.message, 'error');
      del.disabled = false;
    }
  });
  foot.appendChild(del);

  article.appendChild(foot);
  return article;
}

function renderFeed(section) {
  $(`#${section}-feed`).replaceChildren(
    ...state[section].notes.map((n) => renderNote(section, n)),
  );
  $(`#${section}-more`).hidden = state[section].done;
  if (section === 'audio') renderCloudsFoot();
}

// ---------- tagbar (texto) ----------

function renderTagbar(tags) {
  const bar = $('#texto-tagbar');
  bar.replaceChildren(
    ...tags.map(({ value, count }) => {
      const btn = document.createElement('button');
      btn.className = `tag ${state.texto.tag === value ? 'active' : ''}`;
      btn.textContent = `#${value} · ${count}`;
      btn.addEventListener('click', async () => {
        state.texto.tag = state.texto.tag === value ? '' : value;
        await reload('texto');
      });
      return btn;
    }),
  );
}

// ---------- nubes (audio) ----------

// Tamaño de cada etiqueta según su recuento: escala raíz entre 15 y 34 px
// (con un solo uso todas quedan al mínimo, sin divisiones por cero).
function cloudSize(count, max) {
  if (max <= 1) return 15;
  return Math.round(15 + 19 * Math.sqrt((count - 1) / (max - 1)));
}

function renderCloud(el, items, type, selected) {
  // sin adornos ni avisos: una nube sin etiquetas es espacio en blanco
  // (todo irá apareciendo poco a poco)
  el.replaceChildren();
  if (items.length === 0) return;
  const max = Math.max(...items.map((i) => i.count));
  const glyph = type === 'mention' ? '@' : '#';
  // orden alfabético en la nube (el recuento ya manda en el tamaño)
  for (const { value, count } of [...items].sort((a, b) => a.value.localeCompare(b.value))) {
    const btn = document.createElement('button');
    btn.className = `cloud-item ${selected.has(value) ? 'active' : ''}`;
    btn.style.fontSize = `${cloudSize(count, max)}px`;
    btn.innerHTML = `${glyph}${esc(value)} <span class="count">${count}</span>`;
    btn.addEventListener('click', async () => {
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      await reload('audio');
    });
    el.appendChild(btn);
  }
}

function renderClouds() {
  renderCloud($('#cloud-mentions'), state.audio.labels.mentions, 'mention', state.audio.mentions);
  renderCloud($('#cloud-tags'), state.audio.labels.tags, 'tag', state.audio.tags);
  renderCloudsFoot();
}

function renderCloudsFoot() {
  const s = state.audio;
  const n = s.notes.length;
  const filtering = s.tags.size + s.mentions.size > 0;
  $('#clear-filters').hidden = !filtering;
  // el pie solo habla cuando hay algo que contar: una bitácora recién
  // estrenada es una pantalla en blanco, sin avisos
  $('#clouds-count').textContent =
    s.loaded && (n > 0 || filtering || s.q)
      ? `${n}${s.done ? '' : '+'} nota${n === 1 ? '' : 's'}${filtering || s.q ? ' con estos filtros' : ''}`
      : '';
  $('#down-hint').hidden = !(s.loaded && n > 0);
}

// ---------- composers: borradores con bloques (como notas8) ----------

const DRAFT_KEYS = { texto: 'bitacora-draft-texto', audio: 'bitacora-draft-audio' };
const recorder = createRecorder();

// Borrador persistente: cada cambio se guarda en localStorage y al volver
// (recarga, atrás, iOS matando la pestaña…) se recupera. Los audios ya viven
// en R2 (r2_key): solo se guardan los metadatos; un bloque aún subiendo
// (busy, sin r2_key) no se puede salvar.
function saveDraft(section) {
  const s = state[section];
  const title = $(`#${section}-title`).value;
  const blocks = s.draft
    .filter((b) => b.kind === 'text' || b.r2_key)
    .map((b) =>
      b.kind === 'text'
        ? { kind: 'text', text: b.text ?? '' }
        : {
            kind: 'audio',
            r2_key: b.r2_key,
            content_type: b.content_type,
            transcript: b.transcript,
            transcript_original: b.transcript_original,
          },
    );
  try {
    if (blocks.length === 0 && !title.trim()) localStorage.removeItem(DRAFT_KEYS[section]);
    else localStorage.setItem(DRAFT_KEYS[section], JSON.stringify({ title, blocks }));
  } catch { /* storage lleno: el borrador vive en memoria */ }
}

function restoreDrafts() {
  let restored = false;
  for (const section of ['texto', 'audio']) {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(DRAFT_KEYS[section]) || 'null');
    } catch { /* json corrupto: de cero */ }
    if (!saved) continue;
    $(`#${section}-title`).value = saved.title || '';
    // los blobs viven en R2 (r2_key): la url se reconstruye al recuperar
    state[section].draft = (saved.blocks || []).map((b) =>
      b.kind === 'audio' ? { ...b, url: `/r2/${b.r2_key}` } : b,
    );
    if (state[section].draft.length > 0 || (saved.title || '').trim()) restored = true;
    renderDraft(section);
  }
  if (restored) toast('borrador recuperado');
}

function renderDraft(section) {
  const box = $(`#${section}-draft`);
  const draft = state[section].draft;
  box.replaceChildren();
  draft.forEach((b, i) => {
    const div = document.createElement('div');
    div.className = 'draft-block';

    const icon = b.kind === 'audio' ? '🎙' : '✎';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML =
      `<span>${icon} ${i + 1}</span>` +
      (b.status ? `<span class="status">${esc(b.status)}</span>` : '');
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'quitar bloque';
    del.addEventListener('click', () => {
      const content = (b.kind === 'audio' ? b.transcript : b.text) ?? '';
      if ((b.r2_key || content.trim()) && !confirm('¿quitar este bloque del borrador?')) return;
      state[section].draft.splice(i, 1);
      renderDraft(section);
    });
    meta.appendChild(del);
    div.appendChild(meta);

    if (b.kind === 'audio' && b.url) {
      const holder = document.createElement('div');
      holder.innerHTML = audioPlayerMarkup({ src: b.url });
      div.appendChild(holder.firstElementChild);
    }

    // el texto (transcripción o manual) es editable en el borrador
    if (b.kind === 'text' || b.transcript != null) {
      const ta = document.createElement('textarea');
      ta.className = 'grow';
      ta.value = b.kind === 'audio' ? (b.transcript ?? '') : (b.text ?? '');
      ta.placeholder = b.kind === 'text' ? 'escribe… (#tags donde quieras)' : '';
      ta.addEventListener('input', () => {
        if (b.kind === 'audio') b.transcript = ta.value;
        else b.text = ta.value;
        autoGrow(ta);
        updatePublish(section);
      });
      div.appendChild(ta);
      box.appendChild(div);
      autoGrow(ta); // ya está en el DOM: scrollHeight es real
      return;
    }
    box.appendChild(div);
  });
  updatePublish(section);
}

function updatePublish(section) {
  const draft = state[section].draft;
  const publishable = draft.some(
    (b) =>
      (b.kind === 'text' && (b.text ?? '').trim()) ||
      (b.kind === 'audio' && b.r2_key && !b.busy),
  );
  const busy = draft.some((b) => b.busy);
  $(`#${section}-publish`).disabled = !publishable || busy;
  saveDraft(section);
}

async function onPublish(section) {
  const blocks = state[section].draft
    .filter(
      (b) =>
        (b.kind === 'text' && (b.text ?? '').trim()) ||
        (b.kind === 'audio' && b.r2_key),
    )
    .map((b) =>
      b.kind === 'text'
        ? { kind: 'text', text: b.text }
        : {
            kind: 'audio',
            r2_key: b.r2_key,
            content_type: b.content_type,
            transcript: b.transcript,
            transcript_original: b.transcript_original,
          },
    );
  if (blocks.length === 0) return;
  $(`#${section}-publish`).disabled = true;
  try {
    await apiJson('POST', '/api/notes', {
      kind: section,
      title: $(`#${section}-title`).value,
      blocks,
    });
    state[section].draft = [];
    $(`#${section}-title`).value = '';
    localStorage.removeItem(DRAFT_KEYS[section]);
    ensureTextoSeed();
    renderDraft(section);
    toast('nota publicada');
    await reload(section);
  } catch (err) {
    toast(err.message, 'error');
    updatePublish(section);
  }
}

// el composer de texto siempre ofrece un bloque donde empezar a escribir
function ensureTextoSeed() {
  if (state.texto.draft.length === 0) {
    state.texto.draft.push({ kind: 'text', text: '' });
  }
}

// ---------- composer de audio: grabar / archivo → subir → transcribir ----------

// Cada audio (grabado o archivo) es un bloque: sube a R2, whisper lo
// transcribe y el texto cae EDITABLE en el borrador. Como notas8.
async function attachAudioBlob(blob) {
  const block = {
    kind: 'audio',
    url: URL.createObjectURL(blob),
    content_type: blob.type,
    status: 'subiendo…',
    busy: true,
  };
  state.audio.draft.push(block);
  renderDraft('audio');

  try {
    const { key } = await uploadAudio(blob);
    block.r2_key = key;
    block.status = 'transcribiendo…';
    renderDraft('audio');
    const { transcript } = await apiJson('POST', '/api/transcribe', { r2_key: key });
    block.transcript = transcript;
    // el whisper crudo se guarda aparte: si corriges antes de publicar,
    // transcript_original conserva lo que dijo el modelo
    block.transcript_original = transcript;
    block.status = '';
  } catch (err) {
    console.error(err);
    if (err instanceof TypeError) {
      // fallo de RED: el bloque se retira (reintentar = volver a grabar)
      state.audio.draft = state.audio.draft.filter((b) => b !== block);
      toast('sin conexión — no se pudo subir el audio', 'error');
    } else if (block.r2_key) {
      // subió pero whisper falló: el audio no se pierde, queda sin texto
      // (el textarea aparece vacío y se puede publicar igual)
      block.status = `sin transcribir: ${err.message}`;
      block.transcript = block.transcript ?? '';
    } else {
      state.audio.draft = state.audio.draft.filter((b) => b !== block);
      toast(err.message, 'error');
    }
  } finally {
    block.busy = false;
    renderDraft('audio');
  }
}

async function onRecordClick() {
  const btn = $('#record');
  if (!recorder.active) {
    try {
      await recorder.start();
    } catch (err) {
      console.error('mic denied', err);
      toast('no se pudo abrir el micro', 'error');
      return;
    }
    btn.classList.add('is-recording');
    btn.textContent = '■ parar';
    return;
  }
  btn.classList.remove('is-recording');
  btn.textContent = '● grabar';
  const blob = await recorder.stop();
  if (!blob) {
    toast('grabación vacía');
    return;
  }
  await attachAudioBlob(blob);
}

// ---------- arranque ----------

function wire() {
  // secciones: enlaces de la topbar + hash del navegador
  window.addEventListener('hashchange', () =>
    setSection(location.hash.replace('#', ''), { push: false }),
  );

  // composer texto: bloques de texto bajo un título
  $('#texto-add').addEventListener('click', () => {
    state.texto.draft.push({ kind: 'text', text: '' });
    renderDraft('texto');
    const tas = document.querySelectorAll('#texto-draft textarea');
    tas[tas.length - 1]?.focus();
  });
  $('#texto-title').addEventListener('input', () => saveDraft('texto'));
  $('#texto-publish').addEventListener('click', () => onPublish('texto'));

  // composer audio: grabar / archivos, cada uno un bloque transcrito
  const recordBtn = $('#record');
  if (canRecord()) {
    recordBtn.addEventListener('click', onRecordClick);
  } else {
    recordBtn.hidden = true;
  }
  $('#add-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    for (const f of e.target.files) attachAudioBlob(f);
    e.target.value = ''; // permite re-elegir el mismo archivo
  });
  $('#audio-title').addEventListener('input', () => saveDraft('audio'));
  $('#audio-publish').addEventListener('click', () => onPublish('audio'));

  // filtros de las nubes
  $('#clear-filters').addEventListener('click', async () => {
    state.audio.tags.clear();
    state.audio.mentions.clear();
    await reload('audio');
  });

  // búsqueda de la sección activa
  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state[state.section].q = e.target.value.trim();
      await reload(state.section);
    }, 300);
  });

  $('#texto-more').addEventListener('click', () =>
    loadMore('texto').catch((e) => toast(e.message, 'error')),
  );
  $('#audio-more').addEventListener('click', () =>
    loadMore('audio').catch((e) => toast(e.message, 'error')),
  );

  $('#logout').addEventListener('click', logout);

  // clicks en #tags y @menciones dentro de las notas → filtran su sección
  document.addEventListener('click', async (e) => {
    const tag = e.target?.dataset?.tag;
    const mention = e.target?.dataset?.mention;
    if (!tag && !mention) return;
    const v = (tag || mention).toLowerCase();
    if (state.section === 'texto') {
      state.texto.tag = state.texto.tag === v ? '' : v;
      await reload('texto');
    } else {
      const set = tag ? state.audio.tags : state.audio.mentions;
      if (set.has(v)) set.delete(v);
      else set.add(v);
      await reload('audio');
    }
  });

  // el alto real de la topbar manda en el 100dvh del hero; y al girar el
  // móvil, la altura auto de los textareas se recalcula
  window.addEventListener('resize', () => {
    measureTopbar();
    document.querySelectorAll('textarea.grow').forEach(autoGrow);
  });
}

async function boot() {
  // sesión antes de pintar nada: los lectores ven la bitácora en solo-lectura
  // (CSS esconde todo lo .writer-only; el server re-valida con 403 igual).
  ME = await apiGet('/api/me');
  if (ME.role !== 'writer') document.body.classList.add('reader');
  $('#logout').textContent = `salir (${ME.user})`;
  wire();
  setupAudioPlayers();
  measureTopbar();
  if (ME.role === 'writer') {
    restoreDrafts();
    ensureTextoSeed();
    renderDraft('texto');
  }
  setSection(location.hash.replace('#', '') || 'texto', { push: false });
}

boot().catch((err) => {
  console.error(err);
  toast(err.message, 'error');
});
