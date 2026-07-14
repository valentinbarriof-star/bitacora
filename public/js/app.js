// bitácora — app principal. Dos secciones que comparten topbar:
//
//   texto (AZUL): título + contenido con #tags. Composer arriba, tagbar,
//   carrete. Como notas8, pero cada entrada es una sola pieza de texto.
//
//   audio (ROJO): la pantalla intermedia — lo que queda hasta los 100dvh
//   partido en dos nubes (@'s a la izquierda, #'s a la derecha; en móvil
//   arriba/abajo) — y debajo el composer de grabación y el carrete. Cada
//   clic en una nube acota el carrete (los filtros se acumulan, AND).

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
  texto: { q: '', tag: '', entries: [], offset: 0, done: false, loaded: false },
  audio: {
    q: '',
    tags: new Set(),      // filtros # activos (acumulables)
    mentions: new Set(),  // filtros @ activos (acumulables)
    entries: [],
    offset: 0,
    done: false,
    loaded: false,
    labels: { tags: [], mentions: [] },
  },
  draft: null, // audio grabado/subido pendiente de publicar
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

// La topbar es sticky y su alto real manda en el 100dvh de las nubes.
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

async function fetchEntries(section, offset) {
  const { entries } = await apiGet(`/api/entries?${queryFor(section, offset)}`);
  return entries;
}

async function reload(section) {
  const s = state[section];
  s.offset = 0;
  const [entries, labels] = await Promise.all([
    fetchEntries(section, 0),
    apiGet(`/api/labels?kind=${section}`),
  ]);
  s.entries = entries;
  s.done = entries.length < LIMIT;
  s.loaded = true;
  if (section === 'texto') {
    renderTextoFeed();
    renderTagbar(labels.tags);
  } else {
    s.labels = labels;
    renderAudioFeed();
    renderClouds();
  }
}

async function loadMore(section) {
  const s = state[section];
  s.offset += LIMIT;
  const entries = await fetchEntries(section, s.offset);
  s.entries.push(...entries);
  s.done = entries.length < LIMIT;
  if (section === 'texto') renderTextoFeed();
  else renderAudioFeed();
}

// ---------- feed ----------

function entryHead(entry, prefix) {
  const head = document.createElement('div');
  head.className = 'entry-head';
  head.innerHTML =
    `<span class="entry-num">${prefix}${entry.id}</span>` +
    (entry.title ? `<span class="entry-title">${esc(entry.title)}</span>` : '') +
    `<span>${fmtDate(entry.created_at)} · ${fmtTime(entry.created_at)}</span>`;
  return head;
}

// Convierte la cabecera en un input inline para el título (writer). El PATCH
// re-sincroniza las etiquetas en el server (el título también cuenta).
function editTitleUI(head, entry, prefix) {
  const num = document.createElement('span');
  num.className = 'entry-num';
  num.textContent = `${prefix}${entry.id}`;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-edit';
  input.value = entry.title || '';
  input.placeholder = 'título (opcional, los #tags cuentan)';

  const save = document.createElement('button');
  save.textContent = 'guardar';
  save.className = 'save';
  const cancel = document.createElement('button');
  cancel.textContent = 'cancelar';
  cancel.addEventListener('click', () => renderFeed(entry.kind));
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await apiJson('PATCH', `/api/entries/${entry.id}`, { title: input.value });
      toast('título guardado');
      await reload(entry.kind);
    } catch (err) {
      toast(err.message, 'error');
      save.disabled = false;
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save.click();
    if (e.key === 'Escape') renderFeed(entry.kind);
  });

  head.classList.add('title-editing');
  head.replaceChildren(num, input, save, cancel);
  input.focus();
}

// Editor inline del cuerpo de una entrada.
function editBodyUI(article, entry) {
  const body = article.querySelector('.entry-body');
  const ta = document.createElement('textarea');
  ta.className = 'editing grow';
  ta.value = entry.body ?? '';
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

  cancel.addEventListener('click', () => renderFeed(entry.kind));
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await apiJson('PATCH', `/api/entries/${entry.id}`, { body: ta.value });
      toast('guardado');
      await reload(entry.kind);
    } catch (err) {
      toast(err.message, 'error');
      save.disabled = false;
    }
  });
}

function entryMeta(article, entry, prefix) {
  const meta = document.createElement('div');
  meta.className = 'entry-meta';

  const editTitle = document.createElement('button');
  editTitle.className = 'writer-only';
  editTitle.textContent = entry.title ? 'editar título' : '+ título';
  editTitle.addEventListener('click', () =>
    editTitleUI(article.querySelector('.entry-head'), entry, prefix),
  );
  meta.appendChild(editTitle);

  const edit = document.createElement('button');
  edit.className = 'writer-only';
  edit.textContent = entry.kind === 'texto' ? 'corregir' : 'corregir texto';
  edit.addEventListener('click', () => editBodyUI(article, entry));
  meta.appendChild(edit);

  const del = document.createElement('button');
  del.className = 'writer-only del';
  del.textContent = 'borrar';
  del.addEventListener('click', async () => {
    if (!confirm(`¿borrar la entrada ${prefix}${entry.id}?`)) return;
    del.disabled = true;
    try {
      await apiJson('DELETE', `/api/entries/${entry.id}`);
      toast('borrada');
      await reload(entry.kind);
    } catch (err) {
      toast(err.message, 'error');
      del.disabled = false;
    }
  });
  meta.appendChild(del);
  return meta;
}

function renderTextoEntry(entry) {
  const article = document.createElement('article');
  article.className = 'entry';
  article.dataset.entry = entry.id;

  article.appendChild(entryHead(entry, '#t'));

  const body = document.createElement('div');
  body.className = 'entry-body';
  if (entry.body) renderParagraphs(body, entry.body);
  article.appendChild(body);

  article.appendChild(entryMeta(article, entry, '#t'));
  return article;
}

function renderAudioEntry(entry) {
  const article = document.createElement('article');
  article.className = 'entry';
  article.dataset.entry = entry.id;

  article.appendChild(entryHead(entry, '#a'));

  if (entry.r2_key) {
    const holder = document.createElement('div');
    holder.innerHTML = audioPlayerMarkup({ src: `/r2/${entry.r2_key}` });
    article.appendChild(holder.firstElementChild);
  }

  const body = document.createElement('div');
  body.className = 'entry-body';
  if (entry.body) renderParagraphs(body, entry.body);
  article.appendChild(body);

  article.appendChild(entryMeta(article, entry, '#a'));
  return article;
}

function renderTextoFeed() {
  $('#texto-feed').replaceChildren(...state.texto.entries.map(renderTextoEntry));
  $('#texto-more').hidden = state.texto.done;
}

function renderAudioFeed() {
  $('#audio-feed').replaceChildren(...state.audio.entries.map(renderAudioEntry));
  $('#audio-more').hidden = state.audio.done;
  renderCloudsFoot();
}

function renderFeed(section) {
  if (section === 'texto') renderTextoFeed();
  else renderAudioFeed();
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
  const n = s.entries.length;
  const filtering = s.tags.size + s.mentions.size > 0;
  $('#clear-filters').hidden = !filtering;
  // el pie solo habla cuando hay algo que contar: una bitácora recién
  // estrenada es una pantalla en blanco, sin avisos
  $('#clouds-count').textContent =
    s.loaded && (n > 0 || filtering || s.q)
      ? `${n}${s.done ? '' : '+'} entrada${n === 1 ? '' : 's'}${filtering || s.q ? ' con estos filtros' : ''}`
      : '';
  $('#down-hint').hidden = !(s.loaded && n > 0);
}

// ---------- composer: texto ----------

const DRAFT_TEXTO_KEY = 'bitacora-draft-texto';

function updateTextoPublish() {
  $('#texto-publish').disabled = !$('#texto-body').value.trim();
  const title = $('#texto-title').value;
  const body = $('#texto-body').value;
  try {
    if (!title.trim() && !body.trim()) localStorage.removeItem(DRAFT_TEXTO_KEY);
    else localStorage.setItem(DRAFT_TEXTO_KEY, JSON.stringify({ title, body }));
  } catch { /* storage lleno: el borrador vive en memoria */ }
}

async function onTextoPublish() {
  const body = $('#texto-body').value.trim();
  if (!body) return;
  $('#texto-publish').disabled = true;
  try {
    await apiJson('POST', '/api/entries', {
      kind: 'texto',
      title: $('#texto-title').value,
      body,
    });
    $('#texto-title').value = '';
    $('#texto-body').value = '';
    autoGrow($('#texto-body'));
    localStorage.removeItem(DRAFT_TEXTO_KEY);
    toast('texto publicado');
    await reload('texto');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    updateTextoPublish();
  }
}

// ---------- composer: audio ----------

const DRAFT_AUDIO_KEY = 'bitacora-draft-audio';
const recorder = createRecorder();

function saveAudioDraft() {
  const body = $('#audio-body').value;
  const d = state.draft;
  try {
    if (!body.trim() && !(d && d.r2_key)) localStorage.removeItem(DRAFT_AUDIO_KEY);
    else
      localStorage.setItem(
        DRAFT_AUDIO_KEY,
        JSON.stringify({
          body,
          r2_key: d?.r2_key ?? null,
          content_type: d?.content_type ?? null,
        }),
      );
  } catch { /* storage lleno */ }
}

function restoreDrafts() {
  try {
    const t = JSON.parse(localStorage.getItem(DRAFT_TEXTO_KEY) || 'null');
    if (t) {
      $('#texto-title').value = t.title || '';
      $('#texto-body').value = t.body || '';
      autoGrow($('#texto-body'));
    }
  } catch { /* json corrupto */ }
  try {
    const a = JSON.parse(localStorage.getItem(DRAFT_AUDIO_KEY) || 'null');
    if (a) {
      $('#audio-body').value = a.body || '';
      autoGrow($('#audio-body'));
      // el blob ya vive en R2: el borrador solo guarda su clave
      if (a.r2_key) {
        state.draft = { r2_key: a.r2_key, content_type: a.content_type, url: `/r2/${a.r2_key}` };
      }
    }
  } catch { /* json corrupto */ }
  if (state.draft || $('#texto-body').value.trim()) toast('borrador recuperado');
  renderAudioDraft();
  updateTextoPublish();
}

function renderAudioDraft() {
  const box = $('#audio-draft');
  const d = state.draft;
  if (!d) {
    box.hidden = true;
    box.replaceChildren();
    updateAudioPublish();
    return;
  }
  box.hidden = false;
  box.replaceChildren();

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML =
    `<span>🎙 audio</span>` + (d.status ? `<span class="status">${esc(d.status)}</span>` : '');
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.title = 'descartar la grabación';
  del.addEventListener('click', () => {
    if (d.r2_key && !confirm('¿descartar esta grabación?')) return;
    state.draft = null;
    renderAudioDraft();
    saveAudioDraft();
  });
  meta.appendChild(del);
  box.appendChild(meta);

  if (d.url) {
    const holder = document.createElement('div');
    holder.innerHTML = audioPlayerMarkup({ src: d.url });
    box.appendChild(holder.firstElementChild);
  }
  updateAudioPublish();
}

function updateAudioPublish() {
  const d = state.draft;
  $('#audio-publish').disabled = !(d && d.r2_key && !d.busy);
}

// grabación o archivo → sube a R2 → queda como borrador hasta publicar
async function attachAudioBlob(blob) {
  const draft = {
    url: URL.createObjectURL(blob),
    content_type: blob.type,
    status: 'subiendo…',
    busy: true,
  };
  state.draft = draft;
  renderAudioDraft();
  try {
    const { key } = await uploadAudio(blob);
    draft.r2_key = key;
    draft.status = '';
  } catch (err) {
    console.error(err);
    state.draft = null;
    toast(
      err instanceof TypeError ? 'sin conexión — no se pudo subir el audio' : err.message,
      'error',
    );
  } finally {
    if (state.draft === draft) draft.busy = false;
    renderAudioDraft();
    saveAudioDraft();
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

async function onAudioPublish() {
  const d = state.draft;
  if (!d || !d.r2_key) return;
  $('#audio-publish').disabled = true;
  try {
    await apiJson('POST', '/api/entries', {
      kind: 'audio',
      body: $('#audio-body').value,
      r2_key: d.r2_key,
      content_type: d.content_type,
    });
    state.draft = null;
    $('#audio-body').value = '';
    autoGrow($('#audio-body'));
    localStorage.removeItem(DRAFT_AUDIO_KEY);
    renderAudioDraft();
    toast('audio publicado');
    await reload('audio');
  } catch (err) {
    toast(err.message, 'error');
    updateAudioPublish();
  }
}

// ---------- arranque ----------

function wire() {
  // secciones: enlaces de la topbar + hash del navegador
  window.addEventListener('hashchange', () =>
    setSection(location.hash.replace('#', ''), { push: false }),
  );

  // composer texto
  $('#texto-body').addEventListener('input', (e) => {
    autoGrow(e.target);
    updateTextoPublish();
  });
  $('#texto-title').addEventListener('input', updateTextoPublish);
  $('#texto-publish').addEventListener('click', onTextoPublish);

  // composer audio
  const recordBtn = $('#record');
  if (canRecord()) {
    recordBtn.addEventListener('click', onRecordClick);
  } else {
    recordBtn.hidden = true;
  }
  $('#add-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await attachAudioBlob(f);
  });
  $('#audio-body').addEventListener('input', (e) => {
    autoGrow(e.target);
    saveAudioDraft();
  });
  $('#audio-publish').addEventListener('click', onAudioPublish);

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

  // clicks en #tags y @menciones dentro de las entradas → filtran su sección
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

  // el alto real de la topbar manda en el 100dvh de las nubes; y al girar el
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
  if (ME.role === 'writer') restoreDrafts();
  setSection(location.hash.replace('#', '') || 'texto', { push: false });
}

boot().catch((err) => {
  console.error(err);
  toast(err.message, 'error');
});
